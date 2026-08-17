import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { checkoutFingerprint, escapedPaths, parentCheckoutOf } from '../src/worktree.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function linkedWorktree(tempDir: () => string): { root: string; worktree: string } {
  const root = join(tempDir(), 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  const worktree = join(root, '.worktrees', 'wt');
  mkdirSync(join(root, '.worktrees'));
  appendFileSync(join(root, '.git', 'info', 'exclude'), '\n.worktrees/\n');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'probe');
  return { root, worktree };
}

function routingYaml(): string {
  return `providers:\n  cursor: { execution: headless, models: [m1] }\ntask_classes:\n  cursor-worker: { provider: cursor, model: m1 }\n`;
}

describe('worktree escape detection', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-worktree-escape-test-');

  it('finds the canonical checkout for a real linked worktree but not a normal checkout or plain directory', () => {
    const { root, worktree } = linkedWorktree(tempDir);
    expect(realpathSync(parentCheckoutOf(worktree)!.parentRoot)).toBe(realpathSync(root));
    expect(parentCheckoutOf(root)).toBeNull();
    expect(parentCheckoutOf(tempDir())).toBeNull();
  });

  it('finds the canonical checkout when called from a nested directory inside a linked worktree', () => {
    const { root, worktree } = linkedWorktree(tempDir);
    const nested = join(worktree, 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    const context = parentCheckoutOf(nested)!;
    expect(realpathSync(context.parentRoot)).toBe(realpathSync(root));
  });

  it('fingerprints clean, untracked, and staged repository states from git status porcelain', () => {
    const { root } = linkedWorktree(tempDir);
    const clean = checkoutFingerprint(root)!;
    expect(clean.head).toMatch(/^[a-f0-9]{40}$/);
    expect(clean.entries).toEqual(new Map());
    writeFileSync(join(root, 'state.txt'), 'untracked');
    const untracked = checkoutFingerprint(root)!;
    expect(untracked.entries.get('state.txt')).toMatch(/^\?\?:[a-f0-9]{16}$/);
    git(root, 'add', 'state.txt');
    const staged = checkoutFingerprint(root)!;
    expect(staged.entries.get('state.txt')).toMatch(/^A :[a-f0-9]{16}$/);
    expect(staged).not.toEqual(untracked);
    expect(checkoutFingerprint(join(root, 'missing'))).toBeNull();
  });

  it('reports only parent paths that appeared or changed between readable fingerprints', () => {
    const clean = { head: 'head', entries: new Map<string, string>() };
    const untracked = { head: 'head', entries: new Map([['escaped.txt', '??:one']]) };
    const staged = { head: 'head', entries: new Map([['escaped.txt', 'A :one']]) };
    expect(escapedPaths(clean, clean)).toEqual([]);
    expect(escapedPaths(clean, untracked)).toEqual(['?? escaped.txt']);
    expect(escapedPaths(untracked, staged)).toEqual(['A escaped.txt']);
    expect(escapedPaths(untracked, untracked)).toEqual([]);
    expect(escapedPaths(null, untracked)).toBeNull();
    expect(escapedPaths(untracked, null)).toBeNull();
  });

  it('records a parent-checkout escape warning without changing a successful worker outcome to failure', async () => {
    const { root, worktree } = linkedWorktree(tempDir);
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(join(root, 'escaped.txt'), 'x');
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const ledger = tempLedger();
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: worktree, identity: IDENTITIES.unbound },
        ledger, () => adapter,
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.escape?.note).toContain('escape-warning:');
      expect(outcome.escape?.note).toContain('escaped.txt');
      expect(ledger.recent(1)[0].error).toContain('escape-warning:');
      expect(ledger.recent(1)[0].error).toContain('escaped.txt');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('does not report an escape when a worker writes only within its own linked worktree', async () => {
    const { worktree } = linkedWorktree(tempDir);
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(join(opts.cwd, 'inside.txt'), 'x');
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const ledger = tempLedger();
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: worktree, identity: IDENTITIES.unbound },
        ledger, () => adapter,
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.error ?? '').not.toContain('escape-warning:');
      expect(ledger.recent(1)[0].error).toBeNull();
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('does not police a plain non-worktree cwd even when another repository changes during the worker run', async () => {
    const plainCwd = tempDir();
    const { root } = linkedWorktree(tempDir);
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(join(root, 'unrelated.txt'), 'x');
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: plainCwd, identity: IDENTITIES.unbound },
        tempLedger(), () => adapter,
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.error ?? '').not.toContain('escape-warning:');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('does not blame parent dirt that existed before a well-behaved worker dispatch began', async () => {
    const { root, worktree } = linkedWorktree(tempDir);
    writeFileSync(join(root, 'pre-existing.txt'), 'already dirty');
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(join(opts.cwd, 'inside.txt'), 'x');
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: worktree, identity: IDENTITIES.unbound },
        tempLedger(), () => adapter,
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.error ?? '').not.toContain('escape-warning:');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('reports a committed parent escape through HEAD movement', () => {
    const { root } = linkedWorktree(tempDir);
    const before = checkoutFingerprint(root)!;
    writeFileSync(join(root, 'committed.txt'), 'escaped');
    git(root, 'add', 'committed.txt');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'escaped');
    const paths = escapedPaths(before, checkoutFingerprint(root));
    expect(paths).toEqual([expect.stringMatching(/^HEAD moved [a-f0-9]{8} → [a-f0-9]{8}$/)]);
  });

  it('reports content changes on an already-dirty parent path', () => {
    const { root } = linkedWorktree(tempDir);
    writeFileSync(join(root, 'dirty.txt'), 'aaa');
    const before = checkoutFingerprint(root)!;
    writeFileSync(join(root, 'dirty.txt'), 'bbb');
    expect(escapedPaths(before, checkoutFingerprint(root))).toEqual(['?? dirty.txt']);
  });

  it('reports parent paths that disappear between fingerprints', () => {
    const { root } = linkedWorktree(tempDir);
    const path = join(root, 'gone.txt');
    writeFileSync(path, 'gone');
    const before = checkoutFingerprint(root)!;
    unlinkSync(path);
    expect(escapedPaths(before, checkoutFingerprint(root))).toEqual(['cleared gone.txt']);
  });

  it('reports parent paths with spaces intact', () => {
    const { root } = linkedWorktree(tempDir);
    const before = checkoutFingerprint(root)!;
    writeFileSync(join(root, 'has space.txt'), 'escaped');
    expect(escapedPaths(before, checkoutFingerprint(root))).toEqual(['?? has space.txt']);
  });

  it('returns the linked worktree root and parent root from a nested cwd', () => {
    const { root, worktree } = linkedWorktree(tempDir);
    const nested = join(worktree, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const context = parentCheckoutOf(nested)!;
    expect(realpathSync(context.worktreeRoot)).toBe(realpathSync(worktree));
    expect(realpathSync(context.parentRoot)).toBe(realpathSync(root));
  });

  it('treats unavailable fingerprints as undecidable rather than clean', () => {
    const { root } = linkedWorktree(tempDir);
    const fingerprint = checkoutFingerprint(root)!;
    expect(escapedPaths(null, fingerprint)).toBeNull();
    expect(escapedPaths(fingerprint, null)).toBeNull();
  });
});
