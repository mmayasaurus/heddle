import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Single-instance advisory lock for the rotator bin (HED-157) — a LOCKFILE-with-pid, because Node
 * has no built-in flock and this project takes zero native deps. Guards against two active-mode
 * rotators (a stray `--run` daemon plus a manual `--once`, say) both deciding to pause/kill the
 * fleet at the same time — a race the supervisor state machine was never designed to survive (it
 * assumes it is the only writer of `markRelaunched`/kill/relaunch for a given pause).
 *
 * A LIVE lock (the pid it names is still alive) refuses a second acquirer outright. A STALE lock
 * (the pid is dead — the prior holder crashed, or was killed, without reaching its cleanup) is
 * silently taken over: the file is holding nothing back, and refusing forever over a dead process
 * would need a human to clear it by hand on every crash.
 */

export interface LockResult {
  ok: boolean;
  /** The pid already holding a LIVE lock. Present only when `ok` is false. */
  heldBy?: number;
}

/** True when `pid` names a live process (a `kill -0` probe — sends no signal). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to take the lock at `lockPath` for `pid`. `isAlive` is injected (defaults to a real
 * `process.kill(pid, 0)` probe) so tests can simulate a live or dead holder without a real process,
 * the same seam `live.ts` uses for `now`/`warn`.
 */
export function acquireLock(
  lockPath: string,
  pid: number,
  isAlive: (pid: number) => boolean = processAlive,
): LockResult {
  // The directory may not exist yet on a fresh ~/.heddle (nothing has necessarily created it before
  // the rotator's first run).
  mkdirSync(dirname(lockPath), { recursive: true });
  // Claim it ATOMICALLY (O_EXCL via flag 'wx'): a check-then-write would let two rotators cold-starting
  // inside the read->write window both see "free" and both win. On EEXIST we inspect the holder — a LIVE
  // pid refuses; a STALE one (dead: crashed without reaching cleanup) is cleared and the exclusive
  // create retried once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(pid), { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readLockPid(lockPath);
      if (existing !== null && isAlive(existing)) return { ok: false, heldBy: existing };
      // Stale (dead pid) or an unreadable/garbage lock — clear it and retry the exclusive create.
      releaseLock(lockPath);
    }
  }
  // Lost a stale-takeover race: another acquirer created a lock between our clear and retry. Refuse
  // rather than clobber a lock we no longer own.
  const winner = readLockPid(lockPath);
  return winner !== null ? { ok: false, heldBy: winner } : { ok: false };
}

/** Release the lock. Idempotent — a missing file (already released, or never acquired) is not an error. */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function readLockPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const pid = Number(raw.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** The rotator-bin modes that must hold the lock before touching pause/kill/relaunch. `--status` reads only. */
export const LOCK_REQUIRED_MODES: ReadonlySet<'run' | 'once' | 'status'> = new Set(['run', 'once']);
