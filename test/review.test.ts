import { execFileSync } from 'node:child_process';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('prepends an actionable diff instruction and leaves a blank line before the task', () => {
    const instruction = diffInstruction('main');
    expect(instruction).toContain('git diff main...HEAD');
    expect(instruction).toContain('git log main..HEAD --oneline');
    expect(instruction.endsWith('\n\n')).toBe(true);
  });
});
