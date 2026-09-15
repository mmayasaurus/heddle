import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { spawnProbe } from '../../src/adapters/subprocess.js';
import { runDoctor } from '../../src/doctor.js';
import type { Definition, DoctorContext } from '../../src/health/checks.js';
import { hooksChecks } from '../../src/health/hooks.js';
import type { DoctorDeps, ProbeResult } from '../../src/health/probe.js';
import { config, fakeDeps } from '../doctor-fixtures.js';

const projectDir = process.cwd();
const configDir = '/home/probe/.claude';
const userSettings = `${configDir}/settings.json`;
type Clock = { value: number };

function settings(
  event: string,
  hooks: Record<string, unknown> | Record<string, unknown>[],
  matcher?: string,
): Uint8Array {
  const list = Array.isArray(hooks) ? hooks : [hooks];
  return Buffer.from(JSON.stringify({ hooks: { [event]: [{ hooks: list, ...(matcher === undefined ? {} : { matcher }) }] } }));
}

function context(
  files: Record<string, Uint8Array | undefined>,
  clock: Clock,
  execHook: DoctorDeps['execHook'],
  hooksMs = 180_000,
): DoctorContext {
  return {
    deps: {
      env: { CLAUDE_CONFIG_DIR: configDir },
      execFile: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      execHook,
      readFileBytes: async (path) => files[path],
      sha256: () => '', gitBehindOriginMain: async () => undefined,
      now: () => new Date(clock.value), paths: { project: projectDir },
    },
    budgets: { binaryMs: 1, loginMs: 1, catalogMs: 1, graceMs: 1, hooksMs },
    routingPath: '', coreRoot: '', heddleDir: '', lanes: { ok: false, error: '' }, missing: new Set(),
  };
}

async function run(definitions: Definition[]) {
  const entries = [];
  for (const definition of definitions) entries.push({ ...definition, ...(await definition.run()) });
  return entries;
}

function response(clock: Clock, result: ProbeResult, elapsed = 0): DoctorDeps['execHook'] {
  return async () => {
    clock.value += elapsed;
    return result;
  };
}

async function one(hook: Record<string, unknown>, result: ProbeResult, elapsed = 0, event = 'PreToolUse') {
  const clock = { value: 0 };
  const ctx = context({ [userSettings]: settings(event, hook) }, clock, response(clock, result, elapsed));
  return (await run(await hooksChecks(ctx, projectDir)))[0];
}

describe('hooksChecks', () => {
  test('reports a fast command hook as ok', async () => {
    const entry = await one({ type: 'command', command: 'hook', timeout: 5 }, { stdout: '', stderr: '', exitCode: 0, timedOut: false }, 5);
    expect(entry).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('5ms') });
  });

  test('flags slow command hooks', async () => {
    const entry = await one({ type: 'command', command: 'hook', timeout: 5 }, { stdout: '', stderr: '', exitCode: 0, timedOut: false }, 4_600);
    expect(entry).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('slow') });
  });

  test('marks just-over 75% of a hook timeout as slow', async () => {
    const entry = await one({ type: 'command', command: 'hook', timeout: 4 }, { stdout: '', stderr: '', exitCode: 0, timedOut: false }, 3_100);
    expect(entry).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('slow') });
  });

  test('keeps just-under 75% of a hook timeout ok', async () => {
    const entry = await one({ type: 'command', command: 'hook', timeout: 4 }, { stdout: '', stderr: '', exitCode: 0, timedOut: false }, 2_900);
    expect(entry).toMatchObject({ outcome: 'ok', detail: expect.not.stringContaining('slow') });
  });

  test('flags perma-timeout hooks', async () => {
    const entry = await one({ type: 'command', command: 'hook', timeout: 5 }, { stdout: '', stderr: '', exitCode: null, timedOut: true });
    expect(entry).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('perma-timeout') });
  });

  test('fails a budget-capped default-timeout hook as hung after the interactive floor', async () => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      clock.value += 180_000;
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    });
    const [entry] = await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(180_000);
    expect(entry).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('hung') });
  });

  test('leaves a budget-capped default-timeout hook unverified below the interactive floor', async () => {
    const clock = { value: 0 };
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }) }, clock, async () => {
      clock.value += 20_000;
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    }, 20_000);
    const [entry] = await run(await hooksChecks(ctx, projectDir));
    expect(entry).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('unverified') });
  });

  test('treats blocking feedback as an engaged hook', async () => {
    const entry = await one({ type: 'command', command: 'hook' }, { stdout: '', stderr: '', exitCode: 2, timedOut: false });
    expect(entry).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('blocking decision') });
  });

  test('flags exit 127 as missing', async () => {
    const entry = await one({ type: 'command', command: 'not-found' }, { stdout: '', stderr: '', exitCode: 127, timedOut: false });
    expect(entry).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('missing') });
  });

  test('flags exit 126 as not executable', async () => {
    const entry = await one({ type: 'command', command: 'not-exec' }, { stdout: '', stderr: '', exitCode: 126, timedOut: false });
    expect(entry).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('not executable') });
  });

  test('warns on other nonzero exits with stderr', async () => {
    const entry = await one({ type: 'command', command: 'hook' }, { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false });
    expect(entry).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('errored (exit 1)') });
    expect(entry.detail).toContain('boom');
  });

  test('skips non-command hooks', async () => {
    const entry = await one({ type: 'prompt', command: 'ignored' }, { stdout: '', stderr: '', exitCode: 0, timedOut: false });
    expect(entry).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('non-command') });
  });

  test('reports unparseable settings while probing another valid settings file', async () => {
    const clock = { value: 0 };
    const ctx = context({
      [userSettings]: Buffer.from('{'),
      [`${projectDir}/.claude/settings.json`]: settings('PreToolUse', { type: 'command', command: 'hook' }),
    }, clock, response(clock, { stdout: '', stderr: '', exitCode: 0, timedOut: false }));
    const entries = await run(await hooksChecks(ctx, projectDir));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('unparseable settings') });
    expect(entries[1]).toMatchObject({ outcome: 'ok' });
  });

  test('uses the UserPromptSubmit default timeout', async () => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('UserPromptSubmit', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(30_000);
  });

  test('uses the PreModelSwitch default timeout', async () => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('PreModelSwitch', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(30_000);
  });

  test('uses the MessageDisplay default timeout', async () => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('MessageDisplay', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(10_000);
  });

  test('fails a budget-capped timeout exactly at the interactive floor as hung', async () => {
    const clock = { value: 0 };
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }) }, clock, async () => {
      clock.value += 30_000;
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    }, 30_000);
    const [entry] = await run(await hooksChecks(ctx, projectDir));
    expect(entry).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('hung') });
  });

  test('skips remaining hooks when the total budget is exhausted', async () => {
    const clock = { value: 0 };
    let calls = 0;
    const ctx = context({ [userSettings]: settings('PreToolUse', [{ type: 'command', command: 'one' }, { type: 'command', command: 'two' }]) }, clock, async () => {
      calls += 1;
      clock.value += 10;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    }, 5);
    const entries = await run(await hooksChecks(ctx, projectDir));
    expect(entries[0]).toMatchObject({ outcome: 'ok' });
    expect(entries[1]).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('budget exhausted after 1 hooks') });
    expect(calls).toBe(1);
  });

  test('caps a timed-out hook at the remaining sweep budget and leaves it unverified', async () => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook', timeout: 600 }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      clock.value += 50;
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    }, 50);
    const [entry] = await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(50);
    expect(entry).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('budget') });
    expect(entry.detail).toContain('unverified');
    expect(entry.detail).not.toContain('perma-timeout');
  });

  test.each([0, -5])('substitutes the default timeout for invalid declared timeout %s', async (declaredTimeout) => {
    const clock = { value: 0 };
    let timeoutMs = 0;
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook', timeout: declaredTimeout }) }, clock, async (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    }, 700_000);
    const [entry] = await run(await hooksChecks(ctx, projectDir));
    expect(timeoutMs).toBe(600_000);
    expect(entry).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('declared timeout') });
    expect(entry.detail).toContain('invalid');
  });

  test('passes args through only when declared', async () => {
    const clock = { value: 0 };
    const received: Array<string[] | undefined> = [];
    const ctx = context({ [userSettings]: settings('PreToolUse', [{ type: 'command', command: 'one', args: ['x'] }, { type: 'command', command: 'two' }]) }, clock, async (_c, args) => {
      received.push(args);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(received).toEqual([['x'], undefined]);
  });

  test('resolves the ${CLAUDE_PROJECT_DIR} placeholder in the command before probing', async () => {
    const clock = { value: 0 };
    let command = '';
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh' }) }, clock, async (received) => {
      command = received;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(command).toBe(`${projectDir}/.claude/hooks/x.sh`);
  });

  test('resolves the ${CLAUDE_PROJECT_DIR} placeholder in every args element before probing', async () => {
    const clock = { value: 0 };
    let received: string[] | undefined;
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook', args: ['--config', '${CLAUDE_PROJECT_DIR}/cfg.json'] }) }, clock, async (_command, args) => {
      received = args;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(received).toEqual(['--config', `${projectDir}/cfg.json`]);
  });

  test('passes the probe marker environment', async () => {
    const clock = { value: 0 };
    let seen: { env: NodeJS.ProcessEnv; stdin: string } | undefined;
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      seen = opts;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect(seen?.env.HEDDLE_DOCTOR_PROBE).toBe('1');
    expect(seen?.env.HEDDLE_DOCTOR_PROBE_SESSION).toMatch(/^heddle-doctor-probe-[0-9a-f]{8}$/);
    expect(seen?.env.CLAUDE_PROJECT_DIR).toBe(projectDir);
  });

  test('sends a synthetic event payload with a nonexistent transcript', async () => {
    const clock = { value: 0 };
    let stdin = '';
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }) }, clock, async (_c, _a, opts) => {
      stdin = opts.stdin;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    const payload = JSON.parse(stdin) as Record<string, unknown>;
    expect(payload).toMatchObject({ hook_event_name: 'PreToolUse', cwd: projectDir, tool_name: 'Bash' });
    expect(existsSync(payload.transcript_path as string)).toBe(false);
  });

  test.each([
    ['Grep|Glob', 'Grep'],
    ['mcp__memtrace__.*', 'mcp__memtrace__probe'],
    ['[Ww]rite', 'Write'],
    ['mcp__x__list-tools', 'mcp__x__list-tools'],
  ])('uses the first matcher alternative as the PreToolUse tool name', async (matcher, toolName) => {
    const clock = { value: 0 };
    let stdin = '';
    const ctx = context({ [userSettings]: settings('PreToolUse', { type: 'command', command: 'hook' }, matcher) }, clock, async (_c, _a, opts) => {
      stdin = opts.stdin;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    });
    await run(await hooksChecks(ctx, projectDir));
    expect((JSON.parse(stdin) as { tool_name?: string }).tool_name).toBe(toolName);
  });

  test('returns no rows when all settings files are absent', async () => {
    const clock = { value: 0 };
    const ctx = context({}, clock, response(clock, { stdout: '', stderr: '', exitCode: 0, timedOut: false }));
    expect(await hooksChecks(ctx, projectDir)).toEqual([]);
  });

  test('uses hooks checks exclusively when runDoctor probes hooks', async () => {
    const paths = config();
    const report = await runDoctor({ provider: 'cursor', probeHooks: true }, fakeDeps({ ...paths, project: projectDir }, {
      env: { CLAUDE_CONFIG_DIR: configDir },
      readFileBytes: async (path) => path === userSettings
        ? settings('PreToolUse', { type: 'command', command: 'hook' })
        : undefined,
    }));
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'hooks:user:PreToolUse:0.0', kind: 'hooks', outcome: 'ok' });
  });

  test('returns exit code 1 when a hook probe fails', async () => {
    const paths = config();
    const report = await runDoctor({ probeHooks: true }, fakeDeps({ ...paths, project: projectDir }, {
      env: { CLAUDE_CONFIG_DIR: configDir },
      readFileBytes: async (path) => path === userSettings
        ? settings('PreToolUse', { type: 'command', command: 'not-found' })
        : undefined,
      execHook: async () => ({ stdout: '', stderr: '', exitCode: 127, timedOut: false }),
    }));
    expect(report.exitCode).toBe(1);
  });

  test('uses a supplied hooks budget for the hook probe deadline', async () => {
    const paths = config();
    let timeoutMs = 0;
    const report = await runDoctor({ probeHooks: true }, {
      ...fakeDeps({ ...paths, project: projectDir }, {
        env: { CLAUDE_CONFIG_DIR: configDir },
        readSettingsBytes: async (path) => path === userSettings
          ? settings('PreToolUse', { type: 'command', command: 'hook' })
          : undefined,
        execHook: async (_command, _args, opts) => {
          timeoutMs = opts.timeoutMs;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        },
      }),
      timeouts: { hooksMs: 700_000 },
    });
    expect(timeoutMs).toBe(600_000);
    expect(report.checks[0]).not.toMatchObject({ outcome: 'warn' });
  });

  test('reports unreadable hook settings distinctly', async () => {
    const paths = config();
    const report = await runDoctor({ probeHooks: true }, fakeDeps({ ...paths, project: projectDir }, {
      env: { CLAUDE_CONFIG_DIR: configDir },
      readFileBytes: async () => undefined,
      readSettingsBytes: async () => { throw new Error('EACCES: permission denied'); },
    }));
    expect(report.checks.some((entry) => entry.outcome === 'fail' && entry.detail.includes('unreadable'))).toBe(true);
    expect(report.checks.some((entry) => entry.detail.includes('unparseable'))).toBe(false);
  });
});

describe('spawnProbe', () => {
  test('writes stdin and captures stdout', async () => {
    await expect(spawnProbe('/bin/sh', ['-c', 'cat'], { cwd: projectDir, env: process.env, stdin: 'hi', timeoutMs: 5_000 }))
      .resolves.toMatchObject({ stdout: 'hi', exitCode: 0, timedOut: false });
  });

  test('preserves blocking exit code', async () => {
    await expect(spawnProbe('/bin/sh', ['-c', 'exit 2'], { cwd: projectDir, env: process.env, stdin: '', timeoutMs: 5_000 }))
      .resolves.toMatchObject({ exitCode: 2, timedOut: false });
  });
});
