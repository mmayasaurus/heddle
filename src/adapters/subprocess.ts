import { spawn, type ChildProcess } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';

// The largest persisted worker result is ~34 KB; raw stream-json includes tool blocks, so 32 MiB
// leaves a >100× margin for legitimate output while bounding runaway stdout/stderr to ~64 MiB.
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;
// After a timeout kill, how long to wait for the normal 'close' before force-settling. Exported so the
// grace-path test can assert run() actually waited for this timer rather than settling via an early
// 'close' — a literal there could silently drift out of sync with this value.
export const GRACE_MS = 1000;

const liveChildren = new Set<ChildProcess>();
let exitHandlersInstalled = false;

function reapAll(): void {
  for (const child of liveChildren) {
    try {
      // Full Windows process-tree reaping (taskkill /T) is out of scope; this is child-only best effort.
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // The child has already exited.
    }
  }
}

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = () => {
      reapAll();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
  process.on('exit', reapAll);
}

function capAppend(acc: string, accBytes: number, chunk: string, cap: number):
  { acc: string; accBytes: number; hit: boolean } {
  if (accBytes >= cap) return { acc, accBytes, hit: true };

  const chunkBytes = Buffer.byteLength(chunk);
  if (accBytes + chunkBytes <= cap) {
    return { acc: acc + chunk, accBytes: accBytes + chunkBytes, hit: false };
  }

  let taken = '';
  let used = accBytes;
  for (const cp of chunk) {
    const cpBytes = Buffer.byteLength(cp);
    if (used + cpBytes > cap) break;
    taken += cp;
    used += cpBytes;
  }
  return { acc: acc + taken, accBytes: used, hit: true };
}

export function run(bin: string, args: string[], cwd: string, timeoutMs: number,
                    envOverrides?: Record<string, string>, envUnset?: string[],
                    maxStreamBytes = DEFAULT_MAX_STREAM_BYTES):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }> {
  return new Promise((resolve) => {
    // stdin 'ignore' is load-bearing — every subprocess adapter must close stdin.
    const { env } = buildWorkerEnv({ overrides: envOverrides, unset: envUnset });
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    installExitHandlers();
    if (child.pid !== undefined) liveChildren.add(child);
    // 'exit' (the process has ended) is the ONLY event that means the child is truly dead, so it is the
    // SOLE point that removes it from reapAll's registry. Never 'close'/'error'/finish()/the grace net,
    // any of which can fire while the process is still alive (an EPERM-unkillable child, or a grace
    // force-settle) and would wrongly drop it from the parent-cancel sweep.
    child.on('exit', () => { liveChildren.delete(child); });
    // Decode as UTF-8 at the stream so a multi-byte char split across two chunks is not corrupted by
    // `+= d` Buffer→string coercion (codacy/copilot #69 — a latent bug all four original runners shared).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    // 'error' and 'close' can BOTH fire (e.g. spawn failure then close) — settle exactly once.
    let settled = false;
    let killedByTimer = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({ stdout, stderr, exitCode, timedOut, truncated });
    };
    const timer = setTimeout(() => {
      killedByTimer = true;
      try {
        if (process.platform === 'win32' || child.pid === undefined) {
          try { child.kill('SIGKILL'); } catch { /* already exited or unkillable */ }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (err) {
            // ESRCH = the group is already gone (child already dead) — nothing to fall back to. Any
            // other failure (e.g. EPERM from a setuid/sandbox descendant) means the group-kill was
            // rejected but the child may still be alive, so try a direct child kill.
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
              try { child.kill('SIGKILL'); } catch { /* already exited or unkillable */ }
            }
          }
        }
      } finally {
        // Arm the grace net unconditionally — even if a kill threw. If 'close' has not settled run() by
        // GRACE_MS (an escaped setsid/double-fork grandchild still holding the inherited pipes, or a
        // kill that could not land), unref + destroy the streams and force-settle as timedOut, so run()
        // can never outlast timeoutMs + GRACE_MS.
        graceTimer = setTimeout(() => {
          if (settled) return;
          child.unref();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, true);
        }, GRACE_MS);
      }
    }, timeoutMs);
    child.stdout.on('data', (d: string) => {
      const capped = capAppend(stdout, stdoutBytes, d, maxStreamBytes);
      stdout = capped.acc;
      stdoutBytes = capped.accBytes;
      truncated ||= capped.hit;
    });
    child.stderr.on('data', (d: string) => {
      const capped = capAppend(stderr, stderrBytes, d, maxStreamBytes);
      stderr = capped.acc;
      stderrBytes = capped.accBytes;
      truncated ||= capped.hit;
    });
    child.on('close', (code, signal) => {
      // Decide timedOut from the outcome signal, not a pre-kill guess.
      finish(code, killedByTimer && signal === 'SIGKILL');
    });
    child.on('error', (err) => {
      // A post-spawn kill error (e.g. EPERM surfacing asynchronously after the timer fired) can land
      // here; it must NOT masquerade as a spawn failure or steal the timedOut result. When the timer
      // already fired, keep the diagnostic in stderr and let the grace net settle as timedOut.
      if (killedByTimer) {
        stderr = `${stderr}\nkill error: ${String(err)}`;
        return;
      }
      stderr = `${stderr}\nspawn error: ${String(err)}`;
      finish(null, false);
    });
  });
}
