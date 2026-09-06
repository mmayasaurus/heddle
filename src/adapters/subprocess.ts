import { spawn, type ChildProcess } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';

// The largest persisted worker result is ~34 KB; raw stream-json includes tool blocks, so 32 MiB
// leaves a >100× margin for legitimate output while bounding runaway stdout/stderr to ~64 MiB.
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;
const GRACE_MS = 1000;

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
      liveChildren.delete(child);
      resolve({ stdout, stderr, exitCode, timedOut, truncated });
    };
    const timer = setTimeout(() => {
      killedByTimer = true;
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else if (child.pid === undefined) {
        child.kill('SIGKILL');
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child has already exited.
          }
        }
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, true);
      }, GRACE_MS);
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
      stderr = `${stderr}\nspawn error: ${String(err)}`;
      finish(null, false);
    });
  });
}
