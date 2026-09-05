import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveOwnerId, markerBody, parseMarker, resolveRepoNwo, runPrOwn, type GhRunner } from '../src/pr-own.js';

describe('PR ownership helpers', () => {
  it('uses the linked worktree name from a .worktrees directory', () => {
    expect(deriveOwnerId({ topLevel: '/repos/heddle/.worktrees/T-docs', branch: 'feature' })).toBe('T-docs');
  });

  it('uses a path hash for every non-worktree checkout', () => {
    const topLevel = '/repos/heddle';
    expect(deriveOwnerId({ topLevel, branch: 'feature/pr-own' })).toBe(deriveOwnerId({ topLevel, branch: 'other-branch' }));
  });

  it('uses a stable absolute-path hash for detached HEAD', () => {
    const topLevel = '/repos/heddle';
    const expected = createHash('sha256').update(topLevel).digest('hex').slice(0, 8);
    expect(deriveOwnerId({ topLevel, branch: null })).toBe(expected);
  });

  it('regression HED-414 — distinct non-worktree checkouts do not collide on main or master', () => {
    for (const branch of ['main', 'master']) {
      expect(deriveOwnerId({ topLevel: '/repos/one', branch }))
        .not.toBe(deriveOwnerId({ topLevel: '/repos/two', branch }));
    }
  });

  it('prefers the explicit HEDDLE_PR_OWNER override', () => {
    expect(deriveOwnerId({ topLevel: '/repos/heddle', branch: 'main', override: 'operator-1' })).toBe('operator-1');
  });

  it('formats and parses a PR-OWNER marker', () => {
    const marker = markerBody('T-docs', '2026-08-28T12:00:00Z', '2026-08-28T13:00:00Z');
    expect(marker).toContain('<!-- PR-OWNER owner=T-docs since=2026-08-28T12:00:00Z heartbeat=2026-08-28T13:00:00Z -->');
    expect(parseMarker(marker)).toEqual({
      owner: 'T-docs', since: '2026-08-28T12:00:00Z', heartbeat: '2026-08-28T13:00:00Z',
    });
  });

  it('resolves the repo from git before using gh, with gh as fallback', () => {
    const gh: GhRunner = () => JSON.stringify({ nameWithOwner: 'gh/fallback' });
    const git = (args: string[]) => args.join(' ') === 'config --get remote.origin.gh-resolved' ? 'acme/resolved' : '';
    expect(resolveRepoNwo('/repo', gh, git)).toBe('acme/resolved');
    expect(resolveRepoNwo('/repo', gh, () => '')).toBe('gh/fallback');
  });
});

function ownGh(comments: unknown[] = [], failRepoView = false): GhRunner {
  return (args) => {
    const command = args.join(' ');
    if (command.startsWith('pr view ') && command.endsWith('--json comments')) return JSON.stringify({ comments });
    if (command === 'repo view --json nameWithOwner') {
      if (failRepoView) throw new Error('GraphQL pool drained');
      return JSON.stringify({ nameWithOwner: 'acme/widgets' });
    }
    if (command.startsWith('label create ') || command.includes(' --add-label ') || command.includes(' --remove-label ') || command.startsWith('api repos/')) return '';
    if (command.startsWith('pr comment ')) return '';
    if (command === 'pr list --label claimed --state open --limit 100 --json number') return '[]';
    throw new Error(`unexpected gh call: ${command}`);
  };
}

describe('runPrOwn', () => {
  const owner = 'test-owner';
  const fresh = markerBody('other', '2026-08-28T12:00:00Z', new Date().toISOString());
  const stale = markerBody('other', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  const released = '<!-- PR-OWNER owner=released since=- heartbeat=2026-08-28T12:00:00Z -->';

  function run(command: string, pr: string | undefined, gh: GhRunner) {
    const prior = process.env.HEDDLE_PR_OWNER;
    process.env.HEDDLE_PR_OWNER = owner;
    try { return runPrOwn(command, pr, '/repo', gh); }
    finally { if (prior === undefined) delete process.env.HEDDLE_PR_OWNER; else process.env.HEDDLE_PR_OWNER = prior; }
  }

  it('returns proceed verdicts for unowned, yours, stale, and released markers', () => {
    for (const [body, verdict] of [[[], 'UNOWNED'], [[{ body: markerBody(owner, '2026-08-28T12:00:00Z', new Date().toISOString()) }], 'YOURS'], [[{ body: stale }], 'STALE'], [[{ body: released }], 'RELEASED']] as const) {
      const result = run('check', '7', ownGh([...body]));
      expect(result.code).toBe(0);
      expect(result.data.verdict).toBe(verdict);
    }
  });

  it('stands down for a fresh owner and refuses its claim', () => {
    expect(run('check', '7', ownGh([{ body: fresh }])).code).toBe(3);
    expect(run('claim', '7', ownGh([{ body: fresh }])).code).toBe(3);
  });

  it('claims an unowned PR and falls back to a new marker when repo view fails', () => {
    expect(run('claim', '7', ownGh()).code).toBe(0);
    expect(run('claim', '7', ownGh([{ body: markerBody(owner, '2026-08-28T12:00:00Z', new Date().toISOString()), url: 'https://api.github.com/repos/a/issues/comments/1' }], true)).code).toBe(0);
  });

  it('releases and lists its owned PRs', () => {
    expect(run('release', '7', ownGh()).code).toBe(0);
    expect(run('mine', undefined, ownGh()).code).toBe(0);
  });

  it('rejects a PR URL for every mutating or checking command', () => {
    for (const command of ['claim', 'check', 'release']) expect(run(command, 'https://github.com/acme/widgets/pull/7', ownGh()).code).toBe(0);
  });
});
