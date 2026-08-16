import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
    expect(realpathSync(parentCheckoutOf(worktree)!)).toBe(realpathSync(root));
    expect(parentCheckoutOf(root)).toBeNull();
    expect(parentCheckoutOf(tempDir())).toBeNull();
  });

  it('finds the canonical checkout when called from a nested directory inside a linked worktree', () => {
    const { root, worktree } = linkedWorktree(tempDir);
    const nested = join(worktree, 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(realpathSync(parentCheckoutOf(nested)!)).toBe(realpathSync(root));
  });

  it('fingerprints clean, untracked, and staged repository states from git status porcelain', () => {
    const { root } = linkedWorktree(tempDir);
    expect(checkoutFingerprint(root)).toBe('');
    writeFileSync(join(root, 'state.txt'), 'untracked');
    const untracked = checkoutFingerprint(root)!;
    expect(untracked).toContain('?? state.txt');
    git(root, 'add', 'state.txt');
    const staged = checkoutFingerprint(root)!;
    expect(staged).toContain('A  state.txt');
    expect(staged).not.toBe(untracked);
    expect(checkoutFingerprint(join(root, 'missing'))).toBeNull();
  });

  it('reports only parent paths that appeared or changed between readable fingerprints', () => {
    expect(escapedPaths('', '')).toEqual([]);
    expect(escapedPaths('', '?? escaped.txt\n')).toEqual(['?? escaped.txt']);
    expect(escapedPaths('?? escaped.txt\n', 'A  escaped.txt\n')).toEqual(['A escaped.txt']);
    expect(escapedPaths(null, 'x')).toBeNull();
    expect(escapedPaths('x', null)).toBeNull();
    expect(escapedPaths('?? pre-existing.txt\n', '?? pre-existing.txt\n')).toEqual([]);
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
      expect(outcome.error).toContain('escape-warning:');
      expect(outcome.error).toContain('escaped.txt');
      expect(ledger.recent(1)[0].error).toBe(outcome.error);
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
});
