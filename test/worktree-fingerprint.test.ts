import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutFingerprint } from '../src/worktree.js';
import { useTempResources } from './helpers.js';

// HED-625: checkoutFingerprint hashes every dirty/untracked path with a synchronous readFileSync.
// Guard the reachable hazards so a worker leg cannot hang or OOM the orchestrator:
//   • a tracked file REPLACED by a FIFO — git lists it modified, and readFileSync on a pipe with no
//     writer blocks the event loop forever (a BARE untracked fifo is NOT listed by git, so that path
//     is unreachable — the real vector is a type-change over a tracked path, or a symlink);
//   • a SYMLINK git lists — readFileSync would follow it to whatever it points at (a fifo, /dev/zero);
//   • a very LARGE file — readFileSync buffers the whole thing into memory.
// The fix lstat()s each path first: a symlink is hashed by its TARGET TEXT (symlink:<hash> — read with
// readlink, never followed), other non-regular files are marked <special>, and an oversized file is
// marked <large:bytes:mtimeMs>. Crucially each marker still CHANGES when the underlying dirt does — a
// retargeted symlink or an in-place large-file rewrite — so escapedPaths keeps detecting the change at
// an already-dirty path (it would not against a flat <special> / size-only marker). A regular file
// under the cap is still hashed exactly as before.
//
// Unix-syscall vectors (symlink, mkfifo) are skipped on win32 — those calls are not portable and the
// repo has no Windows target; the regular-file and oversized-file guards run everywhere.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

describe('checkoutFingerprint — non-regular and oversized paths (HED-625)', () => {
  const { tempDir } = useTempResources('heddle-worktree-fingerprint-test-');
  const itUnix = it.skipIf(process.platform === 'win32'); // symlink / mkfifo are not portable to win32

  it('still hashes a normal untracked regular file (unchanged behavior)', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    writeFileSync(join(root, 'state.txt'), 'untracked');
    expect(checkoutFingerprint(root)!.entries.get('state.txt')).toMatch(/^\?\?:[a-f0-9]{16}$/);
  });

  itUnix('hashes a symlink by its target text without following it, and detects a retarget', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    writeFileSync(join(root, 'realfile.txt'), 'hi');
    symlinkSync('realfile.txt', join(root, 'link'));
    // The `symlink:` prefix (not a bare hex digest) proves the link was hashed via readlink, NOT
    // followed to realfile.txt's content — a follow would yield a bare `??:<16hex>`.
    const first = checkoutFingerprint(root)!.entries.get('link')!;
    expect(first).toMatch(/^\?\?:symlink:[a-f0-9]{16}$/);
    // Retarget the SAME already-dirty symlink: a flat <special> marker would leave the fingerprint
    // unchanged (qodo HIGH #1 — the change would slip past escapedPaths); hashing the link text makes
    // the retarget visible.
    unlinkSync(join(root, 'link'));
    symlinkSync('a-different-target.txt', join(root, 'link'));
    const second = checkoutFingerprint(root)!.entries.get('link')!;
    expect(second).toMatch(/^\?\?:symlink:[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
  });

  itUnix('does not hang on a tracked file replaced by a FIFO — marks it <special>', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    writeFileSync(join(root, 'tracked.txt'), 'orig');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-q', '-m', 'add tracked');
    // git now lists tracked.txt as changed and the path is a pipe; readFileSync on a pipe with no
    // writer would block forever. The explicit timeout means a regression FAILS here (does not hang
    // the whole suite indefinitely).
    unlinkSync(join(root, 'tracked.txt'));
    execFileSync('mkfifo', [join(root, 'tracked.txt')]);
    const fp = checkoutFingerprint(root)!;
    expect(fp.entries.get('tracked.txt')).toMatch(/:<special>$/);
  }, 5000);

  it('fingerprints an oversized file by size and mtime, and detects an in-place rewrite', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    const big = join(root, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 11534336); // 11 MiB (11 * 1024 * 1024) sparse — over the 10 MiB hash cap; content never read
    // Literal regex, not new RegExp(): the byte count is a fixed constant, so no dynamic construction.
    const marker = /^\?\?:<large:11534336:\d+>$/;
    const first = checkoutFingerprint(root)!.entries.get('big.bin')!;
    expect(first).toMatch(marker);
    // A same-length in-place rewrite changes mtime but not size — a size-only marker (qodo HIGH #3)
    // would collide and hide the change; size+mtime makes it visible. Bump mtime deterministically
    // (no sleep, no content read) to stand in for that rewrite.
    const later = new Date(Date.now() + 5000);
    utimesSync(big, later, later);
    const second = checkoutFingerprint(root)!.entries.get('big.bin')!;
    expect(second).toMatch(marker);
    expect(second).not.toBe(first);
  });
});
