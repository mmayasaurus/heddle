import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { run } from '../src/adapters/subprocess.js';

// The shared runner all four adapters (codex/cursor/claude/agy) now depend on (HED-31). These pin
// the centralized timeout/SIGKILL, spawn-error, settle-once, and UTF-8 behavior directly, rather
// than only through each adapter's integration tests (gitar #69).
const NODE = process.execPath; // absolute → independent of the (billing-stripped) worker PATH
describe('subprocess run() — the shared adapter runner', () => {
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
    const marker = `heddle-subprocess-group-${process.pid}-${Date.now()}-${Math.random()}`;
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ${JSON.stringify(marker)}], { stdio: 'inherit' });`,
      'setTimeout(() => {}, 60000);',
    ].join(' ');
    const started = Date.now();
    const r = await run(NODE, ['-e', parent], process.cwd(), 500);

    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);

    let survivors = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        survivors = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim();
      } catch (error) {
        if ((error as { status?: unknown }).status === 1) {
          survivors = '';
        } else {
          throw error;
        }
      }
      if (survivors.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(survivors).toBe('');
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
