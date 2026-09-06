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
    expect(r).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0, timedOut: false, truncated: false });
  });

  it('reports a non-zero exit code', async () => {
    const r = await run(NODE, ['-e', 'process.exit(3)'], process.cwd(), 10_000);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('kills a process that exceeds the timeout and flags timedOut (exitCode null on SIGKILL)', async () => {
    const r = await run(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], process.cwd(), 300);
    expect(r.timedOut).toBe(true);
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
    let gcPid: number | undefined;
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), 3000);

      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(existsSync(pidfile)).toBe(true);
      gcPid = Number(readFileSync(pidfile, 'utf8'));
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
      try {
        if (gcPid !== undefined) process.kill(gcPid, 'SIGKILL');
      } catch {
        // The grandchild was already reaped.
      }
    }
  });

  it.skipIf(process.platform === 'win32')('settles via the grace timer (not an early close) when an escaped descendant holds inherited pipes', async () => {
    const pidfile = join(tempDir(), 'escaped-grandchild.pid');
    // detached:true puts the grandchild in its own session so the group SIGKILL misses it; it keeps the
    // inherited pipes open, so 'close' can't fire and run() must fall back to the grace timer. The
    // PARENT writes the grandchild's pid synchronously so the proof does not race node startup.
    const TIMEOUT_MS = 3000;
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidfile)}, String(gc.pid));`,
      'setTimeout(() => {}, 60000);',
    ].join(' ');
    let gcPid: number | undefined;
    try {
      const started = Date.now();
      const r = await run(NODE, ['-e', parent], process.cwd(), TIMEOUT_MS);
      const elapsed = Date.now() - started;

      expect(r.timedOut).toBe(true);
      // The grace net fired: run() waited PAST timeout + GRACE_MS rather than settling via an early
      // 'close'. A regression that dropped the grace net and hung would blow the upper bound; one that
      // force-settled without waiting would blow this lower bound. (Timers never fire early, so this is
      // safe under load.)
      expect(elapsed).toBeGreaterThan(TIMEOUT_MS + GRACE_MS - 200);
      expect(elapsed).toBeLessThan(15_000);
      expect(existsSync(pidfile)).toBe(true);
      gcPid = Number(readFileSync(pidfile, 'utf8'));
      expect(gcPid).toBeGreaterThan(0);
      // The escaped grandchild is still alive — it is what held the pipes open and forced the grace
      // path. (Had it died, 'close' would have settled run() normally and this scenario would be
      // untested.) reapAll cannot reach a session-detached double-fork; that is the documented limit.
      expect(() => process.kill(gcPid as number, 0)).not.toThrow();
    } finally {
      try {
        if (gcPid !== undefined) process.kill(gcPid, 'SIGKILL');
      } catch {
        // The escaped grandchild has already exited.
      }
    }
  });

  // NOTE: the timer's exit-at-deadline guard (child already exited when the timer fires → don't flag
  // timedOut) is a sub-millisecond race window that can't be hit deterministically from a unit test —
  // a tight timeout just makes the test itself flaky under load. The guard is exercised in spirit by
  // the clean-exit case above (fast exit → timedOut:false) and reasoned inline in subprocess.ts.

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
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('does not mark an under-cap stream as truncated', async () => {
    const r = await run(NODE, ['-e', "process.stdout.write('small output')"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(r.stdout).toBe('small output');
    expect(r.truncated).toBe(false);
  });

  it('caps multi-byte output on whole code-point boundaries', async () => {
    // cap 1024 lands 2 bytes short of a 3-byte '€' (1022 = 146 whole '€😀' pairs, then '€' needs 3 > 2
    // left) — a naive byte-slicer would emit a split char (U+FFFD); the code-point loop rejects '€' whole.
    const r = await run(NODE, ['-e', "process.stdout.write('€😀'.repeat(500))"], process.cwd(), 5_000, undefined, undefined, 1_024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1_024);
    expect(Buffer.from(r.stdout).toString('utf8')).toBe(r.stdout);
    expect(r.stdout).not.toContain('\uFFFD');
  });

});
