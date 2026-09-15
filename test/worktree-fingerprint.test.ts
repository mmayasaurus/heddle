import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
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
// The fix lstat()s each path first: non-regular files are marked <special> (never read, never
// followed), oversized files are marked <large:bytes> (fingerprinted by size). A regular file is
// still hashed exactly as before.

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

  it('still hashes a normal untracked regular file (unchanged behavior)', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    writeFileSync(join(root, 'state.txt'), 'untracked');
    expect(checkoutFingerprint(root)!.entries.get('state.txt')).toMatch(/^\?\?:[a-f0-9]{16}$/);
  });

  it('marks an untracked symlink <special> without following it to its target', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    writeFileSync(join(root, 'realfile.txt'), 'hi');
    symlinkSync('realfile.txt', join(root, 'link'));
    // Without the lstat guard, readFileSync would FOLLOW the symlink and hash realfile.txt's content
    // (yielding a hex digest); lstat classes the symlink itself as <special> and never follows it.
    expect(checkoutFingerprint(root)!.entries.get('link')).toMatch(/^\?\?:<special>$/);
  });

  it('does not hang on a tracked file replaced by a FIFO — marks it <special>', () => {
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

  it('fingerprints an oversized file by size, without reading its content', () => {
    const root = gitRepo(join(tempDir(), 'repo'));
    const big = join(root, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 11 * 1024 * 1024); // 11 MiB sparse — over the 10 MiB hash cap
    expect(checkoutFingerprint(root)!.entries.get('big.bin')).toBe(`??:<large:${11 * 1024 * 1024}>`);
  });
});
