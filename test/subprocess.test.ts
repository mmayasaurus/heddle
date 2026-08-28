import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/adapters/subprocess.js';
import { useTempResources } from './helpers.js';

// The shared runner all four adapters (codex/cursor/claude/agy) now depend on (HED-31). These pin
// the centralized timeout/SIGKILL, spawn-error, settle-once, and UTF-8 behavior directly, rather
// than only through each adapter's integration tests (gitar #69).
const NODE = process.execPath; // absolute → independent of the (billing-stripped) worker PATH
const resources = useTempResources('heddle-subprocess-');

describe('subprocess run() — the shared adapter runner', () => {
  it('captures stdout, stderr, and the exit code on a clean exit', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], process.cwd(), 10_000);
    expect(r).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0, timedOut: false });
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

  it('regression: hands the child closed stdin rather than an open pipe', async () => {
    const shim = join(resources.tempDir(), 'closed-stdin');
    writeFileSync(shim, '#!/bin/sh\nif read -t 2 line; then echo READ; else echo NOINPUT; fi\n');
    chmodSync(shim, 0o755);
    const started = Date.now();
    const result = await run(shim, [], process.cwd(), 10_000);

    expect(result.stdout).toBe('NOINPUT\n');
    // an OPEN stdin pipe would wait the shim's full 2s `read -t 2`; slack for a loaded machine
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
