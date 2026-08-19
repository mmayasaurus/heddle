import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, LOCK_REQUIRED_MODES } from '../../src/rotate/lock.js';

/**
 * Rotator single-instance lock (HED-157). A LOCKFILE-with-pid — no native flock, zero native deps.
 * The two behaviours that matter: a LIVE holder refuses a second acquirer outright, and a STALE
 * holder (dead pid) is taken over rather than wedging the rotator forever on a crash.
 */
describe('rotator single-instance lock', () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-rotate-lock-'));
    lockPath = join(dir, 'nested', 'rotator.lock'); // nested: also exercises the mkdir-parent path
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('acquires cleanly when no lock file exists yet, creating the parent dir', () => {
    const r = acquireLock(lockPath, 4242, () => { throw new Error('isAlive must not be called — nothing to check liveness of'); });
    expect(r.ok).toBe(true);
    expect(r.heldBy).toBeUndefined();
    expect(readFileSync(lockPath, 'utf8')).toBe('4242');
  });

  it('a second instance REFUSES while a LIVE lock is held, and does not touch the file', () => {
    const first = acquireLock(lockPath, 1111, () => false);
    expect(first.ok).toBe(true);
    const second = acquireLock(lockPath, 2222, (pid) => pid === 1111); // 1111 reported alive
    expect(second.ok).toBe(false);
    expect(second.heldBy).toBe(1111);
    expect(readFileSync(lockPath, 'utf8')).toBe('1111'); // untouched — the second instance did not steal it
  });

  it('a STALE lock (its pid is dead) is silently taken over', () => {
    acquireLock(lockPath, 1111, () => false); // first instance, crashes later without releasing
    const r = acquireLock(lockPath, 2222, (pid) => pid !== 1111); // 1111 no longer alive
    expect(r.ok).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('2222'); // taken over
  });

  it('release then re-acquire by a different pid succeeds (normal handoff, e.g. --once exiting)', () => {
    acquireLock(lockPath, 1111, () => false);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    const r = acquireLock(lockPath, 2222, () => { throw new Error('isAlive must not be called — the lock file is gone'); });
    expect(r.ok).toBe(true);
  });

  it('release is idempotent — releasing a lock that was never acquired does not throw', () => {
    expect(() => releaseLock(lockPath)).not.toThrow();
    expect(() => releaseLock(lockPath)).not.toThrow(); // and again — already gone
  });

  it('LOCK_REQUIRED_MODES gates --run/--once but excludes --status', () => {
    expect(LOCK_REQUIRED_MODES.has('run')).toBe(true);
    expect(LOCK_REQUIRED_MODES.has('once')).toBe(true);
    expect(LOCK_REQUIRED_MODES.has('status')).toBe(false);
  });
});
