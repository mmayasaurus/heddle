import { spawn } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';

export function run(bin: string, args: string[], cwd: string, timeoutMs: number,
                    envOverrides?: Record<string, string>, envUnset?: string[]):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    // stdin 'ignore' is load-bearing — every subprocess adapter must close stdin.
    const { env } = buildWorkerEnv({ overrides: envOverrides, unset: envUnset });
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Decode as UTF-8 at the stream so a multi-byte char split across two chunks is not corrupted by
    // `+= d` Buffer→string coercion (codacy/copilot #69 — a latent bug all four original runners shared).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    // 'error' and 'close' can BOTH fire (e.g. spawn failure then close) — settle exactly once.
    let settled = false;
    let killedByTimer = false;
    const settle = (v: { stdout: string; stderr: string; exitCode: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Decide timedOut from the OUTCOME, not a pre-kill guess: it is a timeout only if the timer fired
      // AND the process died from the signal (exitCode null). A process that exits naturally as the
      // timer fires still reports its real exit code — even if the event loop was blocked past its exit
      // so exitCode wasn't set yet when the timer ran — so it is NOT a timeout (copilot/cubic #69).
      resolve({ ...v, timedOut: killedByTimer && v.exitCode === null });
    };
    const timer = setTimeout(() => { killedByTimer = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => settle({ stdout, stderr, exitCode: code }));
    child.on('error', (err) => settle({ stdout, stderr: `${stderr}\nspawn error: ${String(err)}`, exitCode: null }));
  });
}
