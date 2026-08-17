import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { checkoutFingerprint, destroyedWork } from '../src/worktree.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitRepo(tempDir: () => string): string {
  const root = join(tempDir(), 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, 'a.txt'), 'committed content\n');
  git(root, 'add', 'a.txt');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

function routingYaml(): string {
  return 'providers:\n  cursor: { execution: headless, models: [m1] }\n' +
    'task_classes:\n  cursor-worker: { provider: cursor, model: m1 }\n';
}

describe('destroyed work detection', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-destroyed-work-test-');

  it('reports a modified tracked file reverted by writing its committed bytes back', () => {
    const root = gitRepo(tempDir);
    const path = join(root, 'a.txt');
    writeFileSync(path, 'orchestrator edit\n');
    const before = checkoutFingerprint(root)!;
    writeFileSync(path, 'committed content\n');

    expect(destroyedWork(before, checkoutFingerprint(root))).toEqual(['reverted-or-deleted a.txt']);
  });

  it('reports a deleted untracked file', () => {
    const root = gitRepo(tempDir);
    const path = join(root, 'scratch.md');
    writeFileSync(path, 'scratch\n');
    const before = checkoutFingerprint(root)!;
    unlinkSync(path);

    expect(destroyedWork(before, checkoutFingerprint(root))).toEqual(['reverted-or-deleted scratch.md']);
  });

  it('reports an untracked file taken over by staging', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'new.ts'), 'export {};\n');
    const before = checkoutFingerprint(root)!;
    git(root, 'add', 'new.ts');

    expect(destroyedWork(before, checkoutFingerprint(root))).toEqual(['untracked file taken over new.ts']);
  });

  it('reports HEAD movement', () => {
    const root = gitRepo(tempDir);
    const before = checkoutFingerprint(root)!;
    writeFileSync(join(root, 'committed.ts'), 'export {};\n');
    git(root, 'add', 'committed.ts');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'move head');

    expect(destroyedWork(before, checkoutFingerprint(root))).toEqual([
      expect.stringMatching(/^HEAD moved [a-f0-9]{8} → [a-f0-9]{8}$/),
    ]);
  });

  it('does not report additions or further edits to pre-existing dirty work', () => {
    const root = gitRepo(tempDir);
    const existing = join(root, 'a.txt');
    writeFileSync(existing, 'first edit\n');
    const before = checkoutFingerprint(root)!;
    writeFileSync(join(root, 'new-one.md'), 'one\n');
    writeFileSync(join(root, 'new-two.md'), 'two\n');
    writeFileSync(existing, 'further edit\n');

    expect(destroyedWork(before, checkoutFingerprint(root))).toEqual([]);
  });

  it('returns null when either fingerprint is unavailable', () => {
    const fingerprint = checkoutFingerprint(gitRepo(tempDir))!;

    expect(destroyedWork(null, fingerprint)).toBeNull();
    expect(destroyedWork(fingerprint, null)).toBeNull();
  });

  it('records destroyed work as a warning while preserving a successful dispatch', async () => {
    const root = gitRepo(tempDir);
    const tracked = join(root, 'a.txt');
    const untracked = join(root, 'scratch.md');
    writeFileSync(tracked, 'orchestrator edit\n');
    writeFileSync(untracked, 'scratch\n');
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(tracked, 'committed content\n');
        unlinkSync(untracked);
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const ledger = tempLedger();
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: root, identity: IDENTITIES.unbound },
        ledger, () => adapter,
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.destroyed?.note).toContain('destroyed-work-warning:');
      expect(outcome.destroyed?.note).toContain('a.txt');
      expect(outcome.destroyed?.note).toContain('scratch.md');
      expect(outcome.destroyed?.note).toBeDefined();
      expect(ledger.recent(1)[0].error).toContain(outcome.destroyed!.note);
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('does not record destroyed work when a dispatch only creates a file', async () => {
    const root = gitRepo(tempDir);
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingYaml());
    const previousRouting = process.env.HEDDLE_ROUTING;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = {
      ...fake.adapter,
      dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        writeFileSync(join(root, 'created-by-worker.md'), 'new\n');
        return fake.adapter.dispatch(prompt, opts);
      },
    };

    try {
      process.env.HEDDLE_ROUTING = routing;
      const ledger = tempLedger();
      const outcome = await dispatch(
        { taskClass: 'cursor-worker', prompt: 'x', cwd: root, identity: IDENTITIES.unbound },
        ledger, () => adapter,
      );

      expect(outcome.destroyed).toBeUndefined();
      expect(ledger.recent(1)[0].error ?? '').not.toContain('destroyed-work-warning:');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });
});
