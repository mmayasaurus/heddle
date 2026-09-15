import { spawn, type ChildProcess } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';

// The largest persisted worker result is ~34 KB; raw stream-json includes tool blocks, so 32 MiB
// leaves a >100× margin for legitimate output while bounding runaway stdout/stderr to ~64 MiB.
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;
// How long to wait for the normal 'close' before force-settling — used by two distinct paths: the
// DRAIN path (a natural 'exit' whose 'close' is late because a pipe-holding grandchild keeps the
// inherited fds open — the child is already dead) and the GRACE path (the timeout fired; 'close' may
// never come, and the child may even still be alive if the kill could not reach it — which is why the
// grace path unref()s and the drain path does not). Exported so the grace/drain tests reference it.
export const GRACE_MS = 1000;

const liveChildren = new Set<ChildProcess>();
let exitHandlersInstalled = false;

// SIGKILL the child's whole process group, falling back to a direct child kill on ANY failure. A
// process.kill(-pid) failure is ambiguous: the group may be gone (child already dead — child.kill is
// then a silent no-op) OR the child may have left its group via setpgid and still be alive under its
// own pid (child.kill then actually kills it). So the fallback is unconditional. Windows and a missing
// pid have no process-group semantics / no pid to negate — they can only do the direct kill.
function killGroupOrChild(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Group gone, or the child left its group — fall through to a direct child kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited, or cannot be killed (best effort).
  }
}

function reapAll(): void {
  // Full Windows process-tree reaping (taskkill /T) is out of scope; killGroupOrChild is child-only there.
  for (const child of liveChildren) killGroupOrChild(child);
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

/** Local diagnostic subprocess with explicit environment and stdin; never use for billed workers. */
export function spawnProbe(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; maxStreamBytes?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    installExitHandlers();
    if (child.pid !== undefined) liveChildren.add(child);
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const cap = opts.maxStreamBytes ?? 1_024 * 1_024;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, didTimeout: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ stdout, stderr, exitCode, timedOut: didTimeout });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        killGroupOrChild(child);
      } finally {
        graceTimer = setTimeout(() => {
          if (settled) return;
          child.unref();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, true);
        }, GRACE_MS);
      }
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: string) => {
      const capped = capAppend(stdout, stdoutBytes, chunk, cap);
      stdout = capped.acc;
      stdoutBytes = capped.accBytes;
    });
    child.stderr.on('data', (chunk: string) => {
      const capped = capAppend(stderr, stderrBytes, chunk, cap);
      stderr = capped.acc;
      stderrBytes = capped.accBytes;
    });
    child.on('exit', () => liveChildren.delete(child));
    child.on('close', (code) => finish(code, timedOut));
    child.on('error', (error) => {
      stderr = `${stderr}\nspawn error: ${String(error)}`;
      if (!timedOut) finish(null, false);
    });
  });
}

export function run(bin: string, args: string[], cwd: string, timeoutMs: number,
                    envOverrides?: Record<string, string>, envUnset?: string[],
                    maxStreamBytes = DEFAULT_MAX_STREAM_BYTES, idleTimeoutMs?: number,
                    envRepoint?: { baseUrl: string; authToken: string; service: string }):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; idleTimedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean }> {
  return new Promise((resolve) => {
    // stdin 'ignore' is load-bearing — every subprocess adapter must close stdin.
    const { env } = buildWorkerEnv({ overrides: envOverrides, unset: envUnset, envRepoint });
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    // 'error' and 'close' can BOTH fire (e.g. spawn failure then close) — settle exactly once.
    let settled = false;
    let killReason: 'deadline' | 'idle' | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let childExited = false;
    // Idle is enabled only when the hard deadline sits beyond a full idle window + its grace, so an idle
    // kill can run its own grace net without racing the deadline. (Idle could fire for any timeoutMs >
    // idleTimeoutMs; the + GRACE_MS margin only keeps the two kill paths from overlapping.)
    const idleEnabled = idleTimeoutMs !== undefined && idleTimeoutMs > 0 && timeoutMs > idleTimeoutMs + GRACE_MS;
    const finish = (exitCode: number | null, timedOut: boolean, idleTimedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      resolve({ stdout, stderr, exitCode, timedOut, idleTimedOut, stdoutTruncated, stderrTruncated });
    };
    const armGrace = () => {
      graceTimer = setTimeout(() => {
        if (settled) return;
        // unref so a still-alive child the kill could not reach (e.g. EPERM) does not keep the event
        // loop open via its process handle after we force-settle — destroying the streams frees only
        // those, not the process handle. (The natural-'exit' drain path needs no unref: the child has
        // already exited there, so its handle is gone and unref would be a no-op.)
        child.unref();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, killReason === 'deadline', killReason === 'idle');
      }, GRACE_MS);
    };
    const onIdle = () => {
      // Never idle-kill a child that already died on its own: a late idle fire would group-SIGKILL it
      // (killing grandchildren the drain path spares) and could misreport a natural exit as idleTimedOut
      // with a null exitCode. `childExited` catches it once 'exit' ran; exitCode/signalCode catch the
      // sub-tick race where the OS-level exit precedes the 'exit' event.
      if (settled || killReason !== null || childExited || child.exitCode !== null || child.signalCode !== null) return;
      killReason = 'idle';
      clearTimeout(timer);
      try {
        killGroupOrChild(child);
      } finally {
        armGrace();
      }
    };
    const timer = setTimeout(() => {
      if (settled || killReason !== null) return;
      killReason = 'deadline';
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      try {
        killGroupOrChild(child);
      } finally {
        // Arm the grace net unconditionally — even if the kill threw. If 'close' has not settled run()
        // by GRACE_MS (an escaped setsid/double-fork grandchild still holding the inherited pipes, or a
        // kill that could not land), destroy the streams and force-settle as timedOut, so run() can
        // never outlast timeoutMs + GRACE_MS.
        armGrace();
      }
    }, timeoutMs);
    if (idleEnabled) idleTimer = setTimeout(onIdle, idleTimeoutMs!);
    child.stdout.on('data', (d: string) => {
      const capped = capAppend(stdout, stdoutBytes, d, maxStreamBytes);
      stdout = capped.acc;
      stdoutBytes = capped.accBytes;
      stdoutTruncated ||= capped.hit;
      if (idleEnabled && killReason === null && !settled && !childExited) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, idleTimeoutMs!);
      }
    });
    child.stderr.on('data', (d: string) => {
      const capped = capAppend(stderr, stderrBytes, d, maxStreamBytes);
      stderr = capped.acc;
      stderrBytes = capped.accBytes;
      stderrTruncated ||= capped.hit;
    });
    child.on('exit', (code) => {
      // 'exit' (the process ended) is the ONLY signal that the child is truly dead, so it is the sole
      // point that removes it from reapAll's registry — never 'close'/'error'/finish()/grace, any of
      // which can fire while the process is still alive (an EPERM-unkillable child, or a grace
      // force-settle) and would wrongly drop it from the parent-cancel sweep.
      liveChildren.delete(child);
      // If the child ended on its OWN (not our timeout kill) but a pipe-holding grandchild keeps the
      // inherited streams open, 'close' may never fire. Cancel the now-moot deadline and arm a short
      // drain; if 'close' has not settled by then, settle with the ACTUAL exit status rather than
      // waiting out the whole timeout and mislabeling a finished run as timedOut.
      if (killReason !== null || settled) return;
      // The child is dead, so the idle watchdog is moot. Cancel it and mark exited so a post-'exit'
      // buffered-stdout chunk cannot re-arm it — otherwise a late idle fire could group-kill the dead
      // child or override the real exit status during this drain window.
      childExited = true;
      clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      drainTimer = setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, false);
      }, GRACE_MS);
    });
    child.on('close', (code, signal) => {
      // Decide timedOut from the outcome signal, not a pre-kill guess.
      finish(code, killReason === 'deadline' && signal === 'SIGKILL', killReason === 'idle' && signal === 'SIGKILL');
    });
    child.on('error', (err) => {
      // A post-spawn kill error (e.g. EPERM surfacing asynchronously after the timer fired) can land
      // here; it must NOT masquerade as a spawn failure or steal the timedOut result. When the timer
      // already fired, keep the diagnostic in stderr and let the grace net settle as timedOut.
      if (killReason !== null) {
        stderr = `${stderr}\nkill error: ${String(err)}`;
        return;
      }
      stderr = `${stderr}\nspawn error: ${String(err)}`;
      finish(null, false);
    });
  });
}
