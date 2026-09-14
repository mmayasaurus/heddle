import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, GRACE_MS } from '../src/adapters/subprocess.js';
import { useTempResources } from './helpers.js';

// The shared runner all four adapters (codex/cursor/claude/agy) now depend on (HED-31). These pin
// the centralized timeout/SIGKILL, spawn-error, settle-once, and UTF-8 behavior directly, rather
// than only through each adapter's integration tests (gitar #69).
const NODE = process.execPath; // absolute → independent of the (billing-stripped) worker PATH
describe('subprocess run() — the shared adapter runner', () => {
  const { tempDir } = useTempResources('heddle-subprocess-');
  it('captures stdout, stderr, and the exit code on a clean exit', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], process.cwd(), 10_000);
    expect(r).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0, timedOut: false, idleTimedOut: false, stdoutTruncated: false, stderrTruncated: false });
  });

  it('reports a non-zero exit code', async () => {
    const r = await run(NODE, ['-e', 'process.exit(3)'], process.cwd(), 10_000);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('kills a process that exceeds the timeout and flags timedOut (exitCode null on SIGKILL)', async () => {
    const r = await run(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], process.cwd(), 300);
    expect(r.timedOut).toBe(true);
    expect(r.idleTimedOut).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  it('kills a silent process with the idle watchdog before the hard deadline', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("started"); setTimeout(() => {}, 700)'], process.cwd(), 5_000, undefined, undefined, undefined, 200);
    expect(r.idleTimedOut).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  it('resets the idle watchdog on each stdout chunk', async () => {
    // 50ms chunk cadence vs a 400ms idle budget = 8x margin, so a stalled CI event loop (this suite's
    // real-timer subprocess tests flake under heavy parallel load) does not trip a false idle kill.
    const r = await run(NODE, ['-e', 'let n = 0; const t = setInterval(() => { process.stdout.write("."); if (++n === 12) { clearInterval(t); process.exit(0); } }, 50)'], process.cwd(), 5_000, undefined, undefined, undefined, 400);
    expect(r.idleTimedOut).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('leaves the idle watchdog disabled when its timeout is unset', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("started"); setTimeout(() => process.exit(0), 700)'], process.cwd(), 5_000);
    expect(r.idleTimedOut).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('disables the idle watchdog when the hard deadline cannot exceed its grace window', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("started"); setTimeout(() => {}, 700)'], process.cwd(), 300, undefined, undefined, undefined, 200);
    expect(r.timedOut).toBe(true);
    expect(r.idleTimedOut).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('kills a timed-out process group, including a pipe-holding grandchild', async () => {
    const pidfile = join(tempDir(), 'grandchild.pid');
    // The PARENT writes the grandchild's pid synchronously (spawn().pid is available immediately), so
    // proving the grandchild spawned does not race the grandchild's own node startup under suite load.
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidfile)}, String(gc.pid));`,
      'setTimeout(() => {}, 60000);',
    ].join(' ');
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), 3000);

      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(existsSync(pidfile)).toBe(true);
      const gcPid = Number(readFileSync(pidfile, 'utf8'));
      expect(gcPid).toBeGreaterThan(0);

      let reaped = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          process.kill(gcPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            reaped = true;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(reaped).toBe(true);
    } finally {
      // Read the pid from the file in finally (not the gcPid local, assigned only after the asserts) so
      // a failed assert cannot skip the SIGKILL and leak the grandchild.
      try {
        if (existsSync(pidfile)) process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL');
      } catch {
        // The grandchild was already reaped.
      }
    }
  });

  it.skipIf(process.platform === 'win32')('settles via the grace timer (not a hang) when an escaped descendant holds inherited pipes', async () => {
    const pidfile = join(tempDir(), 'escaped-grandchild.pid');
    // detached:true puts the grandchild in its own session so the group SIGKILL misses it; it keeps the
    // inherited pipes open, so 'close' can NEVER fire. The run-child stays alive to the deadline, so it
    // is killed by the timer (not the natural-exit drain). Grace is therefore the ONLY thing that can
    // settle run() here — a bounded return with timedOut proves the grace net fired; a regression that
    // dropped it would hang past the grandchild's lifetime and blow the upper bound. The PARENT writes
    // the grandchild's pid synchronously so the proof does not race node startup.
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidfile)}, String(gc.pid));`,
      'setTimeout(() => {}, 60000);',
    ].join(' ');
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), 3000);
      const elapsed = Date.now() - started;

      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBeNull();
      // Grace actually WAITED (not an immediate force-settle at the deadline): run() returns at
      // ~timeout(3000) + GRACE_MS. Sound under load — timers never fire early, so elapsed only grows;
      // a regression that force-settled at the deadline with no grace wait would blow this lower bound.
      expect(elapsed).toBeGreaterThan(3_000 + GRACE_MS - 200);
      // ...and bounded well under the escaped grandchild's 30s life ⇒ no hang (grace is the only
      // settler once the child is killed and 'close' can't fire).
      expect(elapsed).toBeLessThan(15_000);
      expect(existsSync(pidfile)).toBe(true);
      const gcPid = Number(readFileSync(pidfile, 'utf8'));
      expect(gcPid).toBeGreaterThan(0);
      // The escaped grandchild is still alive — it held the pipes open and forced the grace path.
      // (reapAll cannot reach a session-detached double-fork; that is the documented limit.)
      expect(() => process.kill(gcPid, 0)).not.toThrow();
    } finally {
      // Read the pid from the file in finally so a failed assert cannot skip the SIGKILL and leak the
      // 30s grandchild.
      try {
        if (existsSync(pidfile)) process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL');
      } catch {
        // The escaped grandchild has already exited.
      }
    }
  });

  it.skipIf(process.platform === 'win32')('settles with the real exit status when the child exits fast but a detached grandchild holds the pipes', async () => {
    const pidfile = join(tempDir(), 'fastexit-grandchild.pid');
    // Deliberately generous: the drain settles at ~exit + GRACE_MS regardless of TIMEOUT_MS, so a large
    // timeout keeps a huge correct-path margin (no fleet-load flake) while the pre-fix full-timeout wait
    // (TIMEOUT_MS + GRACE_MS) still blows the `< TIMEOUT_MS` bound below.
    const TIMEOUT_MS = 15_000;
    // The run-child spawns a DETACHED grandchild that inherits the pipes and lives 30s, records its pid,
    // then exits 0 IMMEDIATELY. 'close' can't fire (the detached grandchild holds the inherited fds),
    // but the child is already done — run() must settle with the real exit status via the drain window,
    // NOT wait out the whole timeout and report timedOut (the pre-fix bug).
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidfile)}, String(gc.pid));`,
      'process.exit(0);',
    ].join(' ');
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), TIMEOUT_MS);
      const elapsed = Date.now() - started;

      // Real status, promptly: the drain settles at ~exit + GRACE_MS (≥ GRACE_MS, never instant), far
      // under the deadline. The pre-fix runner ignored 'exit', waited the full TIMEOUT_MS, then reported
      // timedOut/exitCode null — blowing BOTH the exitCode/timedOut asserts and the upper bound.
      expect(r.exitCode).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(elapsed).toBeGreaterThan(GRACE_MS - 200);
      expect(elapsed).toBeLessThan(TIMEOUT_MS);
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      try {
        if (existsSync(pidfile)) process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL');
      } catch {
        // The grandchild has already exited.
      }
    }
  });

  it.skipIf(process.platform === 'win32')('does not idle-kill or misreport a natural fast exit while the idle watchdog is armed', async () => {
    const pidfile = join(tempDir(), 'idle-fastexit-grandchild.pid');
    // Same fast-exit + detached-grandchild fixture (delayed 'close' → drain path), but with the idle
    // watchdog ARMED (idleTimeoutMs=400 < the ~exit+GRACE_MS drain window, so a SURVIVING idle timer
    // would fire during the drain). The child writes a chunk (arming/resetting idle), spawns the
    // pipe-holding grandchild, then exits 0 immediately. run() must settle with the REAL exit status:
    // the natural 'exit' cancels the now-moot idle timer, so no late idle fire can flip idleTimedOut.
    const TIMEOUT_MS = 15_000;
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "process.stdout.write('go');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidfile)}, String(gc.pid));`,
      'process.exit(0);',
    ].join(' ');
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), TIMEOUT_MS, undefined, undefined, undefined, 400);
      const elapsed = Date.now() - started;
      expect(r.exitCode).toBe(0);
      expect(r.idleTimedOut).toBe(false);
      expect(r.timedOut).toBe(false);
      expect(elapsed).toBeLessThan(TIMEOUT_MS);
    } finally {
      try {
        if (existsSync(pidfile)) process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL');
      } catch {
        // The grandchild has already exited.
      }
    }
  });

  // NOTE: the timer's exit-at-deadline guard (child already exited when the timer fires → don't flag
  // timedOut) is a sub-millisecond race window that can't be hit deterministically from a unit test —
  // a tight timeout just makes the test itself flaky under load. The guard is exercised in spirit by
  // the clean-exit case above (fast exit → timedOut:false) and reasoned inline in subprocess.ts.
  // The idle watchdog's analogous exit race (a late idle fire group-killing an already-dead child, or
  // flipping idleTimedOut on a natural exit) is likewise not deterministically unit-testable; it is
  // guarded by onIdle's `childExited` / `child.exitCode` / `child.signalCode` checks + the 'exit'
  // handler clearing idleTimer, and exercised in spirit by the armed-idle fast-exit case above.

  it('settles once with a spawn error for a nonexistent binary (exitCode null, stderr names it)', async () => {
    const r = await run('heddle-no-such-binary-xyz', [], process.cwd(), 10_000);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/spawn error/);
    expect(r.timedOut).toBe(false);
  });

  it('does not corrupt a multi-byte UTF-8 payload split across stream chunks (codacy/copilot #69)', async () => {
    // ~150KB of 3-byte chars spans several ~64KB stream chunks, so char boundaries land mid-chunk.
    // Without setEncoding('utf8') a split 3-byte char corrupts on the Buffer→string `+= d` coercion.
    // The .repeat() runs INSIDE node so the 150KB never becomes a command-line arg — a 150KB arg
    // exceeds Linux MAX_ARG_STRLEN (~128KB) and makes spawn throw E2BIG on CI (passes on macOS).
    const r = await run(NODE, ['-e', 'process.stdout.write("あ".repeat(50000))'], process.cwd(), 10_000);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('あ'.repeat(50_000));
  });

  it('caps a chatty stream while draining it through a clean exit', async () => {
    const r = await run(NODE, ['-e', "process.stdout.write('x'.repeat(100000))"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1_024);
    expect(r.stdout).toBe('x'.repeat(1024));
    expect(r.stdoutTruncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('does not mark an under-cap stream as truncated', async () => {
    const r = await run(NODE, ['-e', "process.stdout.write('small output')"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(r.stdout).toBe('small output');
    expect(r.stdoutTruncated).toBe(false);
  });

  it('caps multi-byte output on whole code-point boundaries', async () => {
    // cap 1024 lands 2 bytes short of a 3-byte '€' (1022 = 146 whole '€😀' pairs, then '€' needs 3 > 2
    // left) — a naive byte-slicer would emit a split char (U+FFFD); the code-point loop rejects '€' whole.
    const r = await run(NODE, ['-e', "process.stdout.write('€😀'.repeat(500))"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(r.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(r.stdout)).toBe(1022);
    expect(r.stdout).toBe('€😀'.repeat(146));
    expect(Buffer.from(r.stdout).toString('utf8')).toBe(r.stdout);
    expect(r.stdout).not.toContain('\uFFFD');
  });

  it('caps a chatty STDERR stream independently', async () => {
    const r = await run(NODE, ['-e', "process.stderr.write('x'.repeat(100000))"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stdoutTruncated).toBe(false);
  });

});
