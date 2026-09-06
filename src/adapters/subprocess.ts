import { spawn } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';

// The largest persisted worker result is ~34 KB; raw stream-json includes tool blocks, so 32 MiB
// leaves a >100× margin for legitimate output while bounding runaway stdout/stderr to ~64 MiB.
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

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
    const settle = (
      v: { stdout: string; stderr: string; exitCode: number | null },
      signal: NodeJS.Signals | null = null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Decide timedOut from the OUTCOME signal, not a pre-kill guess: a timeout ONLY if the timer
      // fired AND the process died from OUR SIGKILL. A natural exit reports a real code (signal null);
      // an external SIGTERM racing the deadline reports SIGTERM — neither is our timeout (copilot/cubic
      // #69). Keying on the death signal is exact regardless of event-loop timing.
      resolve({ ...v, timedOut: killedByTimer && signal === 'SIGKILL', truncated });
    };
    const timer = setTimeout(() => {
      killedByTimer = true;
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
        return;
      }
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') child.kill('SIGKILL');
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
    child.on('close', (code, signal) => settle({ stdout, stderr, exitCode: code }, signal));
    child.on('error', (err) => settle({ stdout, stderr: `${stderr}\nspawn error: ${String(err)}`, exitCode: null }));
  });
}
