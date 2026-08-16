import { execFileSync } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffInstruction, pickReviewer, sameSnapshot, snapshotWorktree } from '../src/review.js';
import { loadRouting, resolveRoute } from '../src/routing.js';
import { useTempResources } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

describe('adversarial review helpers', () => {
  const { tempDir } = useTempResources('heddle-review-test-');

  it('selects the first different reviewer only when the author matches the primary provider', () => {
    const route = resolveRoute(loadRouting(), 'adversarial-review');
    expect(pickReviewer(route, undefined)).toBeNull();
    expect(pickReviewer(route, 'codex')).toBeNull();
    expect(pickReviewer(route, 'cursor')).toEqual({
      provider: 'gemini', model: 'gemini-3.1-pro-high', reason: 'pool:2 (author is cursor)',
    });
  });

  it('rejects reviewer pools that contain no model family different from the author', () => {
    const path = join(tempDir(), 'routing.yaml');
    writeFileSync(path, `task_classes:\n  only-author:\n    provider: cursor\n    model: m\n    reviewer_pool:\n      - { provider: cursor, model: m }\n  empty-pool:\n    provider: cursor\n    model: m\n`);
    const table = loadRouting(path);
    expect(() => pickReviewer(resolveRoute(table, 'only-author'), 'cursor')).toThrow(/must be a different model family/);
    expect(() => pickReviewer(resolveRoute(table, 'empty-pool'), 'cursor')).toThrow(/must be a different model family/);
  });

  it('reports a non-git directory as unavailable for a mandate comparison', () => {
    const snapshot = snapshotWorktree(tempDir());
    expect(snapshot).toEqual({ git: false, hash: null });
    expect(sameSnapshot(snapshot, snapshot)).toBeNull();
  });

  it('detects tracked, untracked, content, HEAD, and stash changes while excluding ignored files', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'tracked.txt'), 'base');
    git(cwd, 'add', 'tracked.txt');
    commit(cwd, 'init');

    const clean = snapshotWorktree(cwd);
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(true);

    const untracked = join(cwd, 'untracked.txt');
    writeFileSync(untracked, 'aaaa');
    const withUntracked = snapshotWorktree(cwd);
    expect(sameSnapshot(clean, withUntracked)).toBe(false);
    writeFileSync(untracked, 'bbbb'); // Same name and size: the mandate hashes content, not just paths.
    expect(sameSnapshot(withUntracked, snapshotWorktree(cwd))).toBe(false);
    rmSync(untracked);

    appendFileSync(join(cwd, 'tracked.txt'), ' changed');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(false);
    git(cwd, 'checkout', '--', 'tracked.txt');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(true);

    writeFileSync(join(cwd, 'head.txt'), 'new HEAD content');
    git(cwd, 'add', '-A');
    commit(cwd, 'head moved');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(false);
    const afterCommit = snapshotWorktree(cwd);
    appendFileSync(join(cwd, 'tracked.txt'), ' stash me');
    git(cwd, 'stash', 'push', '-q');
    expect(sameSnapshot(afterCommit, snapshotWorktree(cwd))).toBe(false);

    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
    git(cwd, 'add', '.gitignore');
    commit(cwd, 'ignore artifacts');
    const ignoredBase = snapshotWorktree(cwd);
    writeFileSync(join(cwd, 'ignored.txt'), 'outside mandate boundary');
    // Ignored build/tool artifacts are deliberately outside the read-only mandate boundary.
    expect(sameSnapshot(ignoredBase, snapshotWorktree(cwd))).toBe(true);

    expect(sameSnapshot(clean, { git: true, hash: null, error: 'boom' })).toBe(false);
    expect(sameSnapshot({ git: true, hash: null }, snapshotWorktree(cwd))).toBeNull();
  }, 15_000);

  it('normalizes provider casing on BOTH sides and skips unusable pool entries with a reasoned error', () => {
    const route = { taskClass: 'adversarial-review', provider: 'Cursor', model: 'cursor-grok-4.6-high',
      reviewerPool: [{ provider: ' Cursor ', model: 'cursor-grok-4.6-high' }, { provider: 'Gemini', model: 'gemini-3.1-pro-high' }, { provider: 'codex', model: 'gpt-5.6-sol' }] } as any;
    // YAML casing must not dodge the same-family guard: 'Cursor' route + 'cursor' author still matches,
    // the cased pool entry is still recognized as the author's family, and the pick is normalized.
    expect(pickReviewer(route, 'cursor')).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high', reason: 'pool:2 (author is cursor)' });
    // an unusable differing entry (excluded provider, unknown model) is skipped to the next one
    expect(pickReviewer(route, 'cursor', (p) => (p === 'gemini' ? 'provider excluded by policy' : null)))
      .toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', reason: 'pool:3 (author is cursor)' });
    // no usable different entry → the error names what was skipped and why
    expect(() => pickReviewer(route, 'cursor', () => 'provider excluded by policy')).toThrow(/skipped: gemini\/gemini-3.1-pro-high: provider excluded by policy/);
  });

  it('detects a bare git add and a mode-only chmod — index state and file modes are in the digest', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'tracked.txt'), 'body');
    git(cwd, 'add', 'tracked.txt');
    commit(cwd, 'init');
    writeFileSync(join(cwd, 'tracked.txt'), 'dirty');
    const base = snapshotWorktree(cwd);
    // staging the already-dirty file changes NO bytes and does not move HEAD — only the index
    git(cwd, 'add', 'tracked.txt');
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(false);
    git(cwd, 'reset', '-q'); // back to the baseline index
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(true);
    // a chmod changes no bytes either — the mode is part of each file line
    chmodSync(join(cwd, 'tracked.txt'), 0o755);
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(false);
  }, 15_000);

  it('prepends an actionable diff instruction and leaves a blank line before the task', () => {
    const instruction = diffInstruction('main');
    expect(instruction).toContain('git diff main...HEAD');
    expect(instruction).toContain('git log main..HEAD --oneline');
    expect(instruction.endsWith('\n\n')).toBe(true);
  });
});
