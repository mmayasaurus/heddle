import { mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs';

/**
 * Advisory cross-PROCESS lock for the short read-modify-write mutations of shared worktree files
 * (AGENTS.md, .cursor/mcp.json — HED-56). Concurrent dispatches into one cwd are the NORMAL case
 * (SPEC §5: workers run inside their orchestrator's worktree), and two heddle PROCESSES can race
 * the same file; within one process the sync mutation is already atomic on the event loop.
 *
 * `mkdir` is atomic on every platform heddle runs on, so the lock is a directory. Mutations are
 * milliseconds, so contention is waited out with a short spin; a lock older than STALE_MS belongs
 * to a crashed process and is broken. This lock protects the MUTATION only, never the worker run —
 * serializing runs would kill exactly the parallelism the shared-cwd model exists for.
 */
const STALE_MS = 10_000;
const WAIT_MS = 2_000;
const SPIN_MS = 25;

function sleepSync(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

/** Run `fn` holding the lock directory. On timeout the mutation proceeds UNLOCKED with a stderr
 *  note — a stuck peer must not deadlock dispatches; the marker/sidecar formats keep even an
 *  unlocked overlap from destroying non-heddle content. */
export function withFileLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + WAIT_MS;
  let locked = false;
  while (!locked && Date.now() <= deadline) {
    try {
      mkdirSync(lockDir);
      locked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // The parent directory is gone or unwritable — a lock is impossible; run the mutation
        // unlocked and let IT surface the real error (never spin on a hopeless mkdir).
        break;
      }
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > STALE_MS) {
          // Steal by ATOMIC RENAME: of two racers that both saw the stale mtime, exactly one
          // rename succeeds — an rmdir here could delete the WINNER's freshly-created lock and
          // let both proceed (gitar, #17). pid+time make the husk name unique (the two racers
          // are different processes by definition — no RNG needed).
          const husk = `${lockDir}.stale-${process.pid}-${Date.now()}`;
          let stolen = false;
          try { renameSync(lockDir, husk); stolen = true; } catch { /* the other racer won the steal — benign */ }
          if (stolen) {
            try { rmdirSync(husk); } catch (err) {
              process.stderr.write(`heddle: stale lock husk ${husk} could not be removed (${err instanceof Error ? err.message : String(err)}) — harmless leftover, remove manually\n`);
            }
          }
          continue;
        }
      } catch { continue; /* lock vanished between mkdir and stat — retry (deadline-bounded) */ }
      sleepSync(SPIN_MS);
    }
  }
  if (!locked && Date.now() > deadline) {
    process.stderr.write(`heddle: file lock ${lockDir} busy for ${WAIT_MS}ms — proceeding unlocked\n`);
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try { rmdirSync(lockDir); } catch (err) {
        // A release failure means the NEXT taker waits out the stale window — say so.
        process.stderr.write(`heddle: could not release file lock ${lockDir} (${err instanceof Error ? err.message : String(err)}) — peers will stale-break it\n`);
      }
    }
  }
}
