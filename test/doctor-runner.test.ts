import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { run } from '../src/adapters/subprocess.js';
import { runDoctor } from '../src/doctor.js';
import { check, config, fakeDeps, resources } from './doctor-fixtures.js';

describe('runDoctor real runner probes', () => {
  test('regression: a real stuck cursor-agent binary probe times out instead of hanging doctor', async () => {
    const dir = resources.tempDir();
    const shim = join(dir, 'cursor-agent');
    // Hang ONLY on --version (a SIGKILLed sh leaves its `sleep` child holding the pipes, which is the
    // grandchild case the grace deadline exists for); answer the login/catalog probes instantly so the
    // run's wall time measures the binary check alone.
    writeFileSync(
      shim,
      "#!/bin/sh\ncase \"$1\" in\n  --version) trap '' TERM; sleep 5 ;;\n"
        + "  *) echo '{\"isAuthenticated\":true}' ;;\nesac\n",
    );
    chmodSync(shim, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;

    try {
      const started = Date.now();
      const report = await runDoctor(
        { provider: 'cursor' },
        {
          paths: config(),
          timeouts: { binaryMs: 300, loginMs: 300, catalogMs: 300, graceMs: 300 },
        },
      );
      // budget (0.3s) + grace (0.3s) for the stuck probe, generous slack for a loaded machine — a hang
      // would take the shim's full 5s.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(check(report, 'binary:cursor')).toMatchObject({
        outcome: 'warn',
        detail: expect.stringMatching(/^timed out after 0\.3s/),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('regression: a real missing cursor-agent binary skips only its dependent probes', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = resources.tempDir();

    try {
      const report = await runDoctor({ provider: 'cursor' }, { paths: config() });
      expect(check(report, 'binary:cursor')).toMatchObject({
        outcome: 'fail',
        detail: 'missing binary (spawn ENOENT)',
        hint: expect.stringContaining('cursor-agent'),
      });
      expect(check(report, 'login:cursor')).toMatchObject({
        outcome: 'skipped',
        detail: 'binary missing',
      });
      expect(check(report, 'catalog:cursor')).toMatchObject({
        outcome: 'skipped',
        detail: 'binary missing',
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('regression: a real non-executable cursor-agent binary identifies EACCES', async () => {
    const dir = resources.tempDir();
    const shim = join(dir, 'cursor-agent');
    writeFileSync(shim, '#!/bin/sh\necho 1.0\n');
    chmodSync(shim, 0o644);
    const originalPath = process.env.PATH;
    process.env.PATH = dir;

    try {
      const report = await runDoctor({ provider: 'cursor' }, { paths: config() });
      expect(check(report, 'binary:cursor')).toMatchObject({
        outcome: 'fail',
        detail: 'cannot execute (EACCES)',
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('regression: a never-settling dependency respects doctor grace deadlines', async () => {
    const started = Date.now();
    const report = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(undefined, {
        execFile: () => new Promise(() => {}),
        timeouts: { binaryMs: 100, loginMs: 100, catalogMs: 100, graceMs: 100 },
      }),
    );
    expect(check(report, 'binary:cursor')).toMatchObject({
      outcome: 'warn',
      detail: 'timed out after 0.1s — unverified, not proven broken',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('regression: rejected probes are unverified unless their error reports EACCES', async () => {
    const unavailable = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(undefined, {
        execFile: async () => Promise.reject(new Error('boom')),
      }),
    );
    expect(check(unavailable, 'binary:cursor')).toMatchObject({
      outcome: 'warn',
      detail: 'probe could not run — unverified',
    });
    expect(check(unavailable, 'binary:cursor').detail).not.toContain('timed out');

    const inaccessible = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(undefined, {
        execFile: async () => Promise.reject(new Error('spawn cursor-agent EACCES')),
      }),
    );
    expect(check(inaccessible, 'binary:cursor')).toMatchObject({
      outcome: 'fail',
      detail: 'cannot execute (EACCES)',
    });
  });

  test('regression: 1 MiB catalog cap retains models beyond the former 64 KiB limit', async () => {
    const firstDir = resources.tempDir();
    const firstShim = join(firstDir, 'cursor-agent');
    writeFileSync(
      firstShim,
      `#!/bin/sh
case "$1" in
  --version) echo 1.0 ;;
  status) echo '{"isAuthenticated":true}' ;;
  models) echo 'cursor-good - Good'; yes filler | head -c 1200000 ;;
esac
`,
    );
    chmodSync(firstShim, 0o755);
    const lastDir = resources.tempDir();
    const lastShim = join(lastDir, 'cursor-agent');
    writeFileSync(
      lastShim,
      `#!/bin/sh
case "$1" in
  --version) echo 1.0 ;;
  status) echo '{"isAuthenticated":true}' ;;
  models) yes filler | head -c 1200000; echo 'cursor-good - Good' ;;
esac
`,
    );
    chmodSync(lastShim, 0o755);
    const originalPath = process.env.PATH;
    const paths = config({ cursor: 'cursor-good', gemini: 'gemini-3.7-flash-high' });

    try {
      process.env.PATH = `${firstDir}:${originalPath}`;
      const leading = await runDoctor({ provider: 'cursor' }, { paths });
      expect(check(leading, 'catalog:cursor')).toMatchObject({ outcome: 'ok' });

      process.env.PATH = `${lastDir}:${originalPath}`;
      const trailing = await runDoctor({ provider: 'cursor' }, { paths });
      expect(check(trailing, 'catalog:cursor')).toMatchObject({
        outcome: 'fail',
        detail: expect.stringContaining('cursor-work'),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('regression: Cursor fallback-only routes are verified against the catalog', async () => {
    const paths = config(undefined, { cursorFallback: 'cursor-fallback' });
    const listed = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'cursor-agent' && args[0] === 'models') {
            return {
              stdout: 'cursor-fallback - Fallback\n', stderr: '', exitCode: 0, timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(listed, 'catalog:cursor')).toMatchObject({ outcome: 'ok' });
    const absent = await runDoctor({ provider: 'cursor' }, fakeDeps(paths));
    expect(check(absent, 'catalog:cursor')).toMatchObject({
      outcome: 'fail', detail: expect.stringContaining('cursor-work: cursor-fallback'),
    });
  });

  test('regression: JSON catalog entries verify routed Cursor models', async () => {
    const paths = config({ cursor: 'cursor-good', gemini: 'gemini-3.7-flash-high' });
    const listed = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'cursor-agent' && args[0] === 'models') {
            return {
              stdout: JSON.stringify({ models: [{ id: 'cursor-good' }] }),
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(listed, 'catalog:cursor')).toMatchObject({ outcome: 'ok' });
    const absent = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'cursor-agent' && args[0] === 'models') {
            return {
              stdout: JSON.stringify({ models: [{ id: 'other-model' }] }),
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(absent, 'catalog:cursor').outcome).toBe('fail');
  });

  test('regression: uppercase catalog ids verify matching uppercase routing targets', async () => {
    const paths = config({ cursor: 'Cursor-Good', gemini: 'gemini-3.7-flash-high' });
    const report = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'cursor-agent' && args[0] === 'models') {
            return {
              stdout: 'Cursor-Good - Good\n', stderr: '', exitCode: 0, timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(report, 'catalog:cursor')).toMatchObject({ outcome: 'ok' });
  });

  test('regression: hands the child closed stdin rather than an open pipe', async () => {
    const shim = join(resources.tempDir(), 'closed-stdin');
    writeFileSync(shim, '#!/bin/sh\nread line; echo NOINPUT\n');
    chmodSync(shim, 0o755);
    const result = await run(shim, [], process.cwd(), 3_000);

    expect(result.stdout).toBe('NOINPUT\n');
    expect(result.timedOut).toBe(false);
  });
});
