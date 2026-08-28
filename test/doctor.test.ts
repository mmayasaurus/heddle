import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatDoctorReport, runDoctor, type DoctorDeps } from '../src/doctor.js';
import { useTempResources } from './helpers.js';

const resources = useTempResources('heddle-doctor-');
const NOW = new Date('2026-08-28T12:00:00Z');
const CURSOR_CATALOG = `Available models

auto - Auto (default)
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
composer-2.5 - Composer 2.5
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
`;
const AGY_CATALOG = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;

function config(models = { cursor: 'cursor-grok-4.6-high-fast', gemini: 'gemini-3.7-flash-high' }): { routing: string; lanes: string; projects: string; accounts: string } {
  const dir = resources.tempDir();
  const paths = {
    routing: join(dir, 'routing.yaml'), lanes: join(dir, 'lanes.yaml'),
    projects: join(dir, 'projects.json'), accounts: join(dir, 'accounts.json'),
  };
  writeFileSync(paths.routing, `version: 1
providers:
  claude: {status: active}
  codex: {status: active}
  cursor: {status: active}
  gemini: {status: active}
task_classes:
  cursor-work:
    provider: cursor
    model: ${models.cursor}
  claude-work:
    provider: claude
    model: sonnet
  codex-work:
    provider: codex
    model: gpt-good
  gemini-work:
    provider: gemini
    model: ${models.gemini}
`);
  writeFileSync(paths.lanes, `tiers:
  T0-menial: [gemini]
  T1-workhorse: [codex]
  T1Q-quality-reserve: [cursor]
  T2-judgment: [claude]
  T3-orchestrator: [claude]
  T3-escalation: {via: claude, opt_in: true, requires_failed_attempts: 1, fable_escalations_weekly: 1}
floors:
  claude: {never_below_pct: 10, residency_cap_below_pct: 20, residency_max: 2}
  cooling_minutes: 5
  menial_verify_days: 14
caps: {openrouter_credits_weekly_usd: 1}
guards: {never_via_cursor: []}
`);
  return paths;
}

function fakeDeps(paths = config(), overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    paths,
    now: () => new Date('2026-09-10T12:00:00Z'),
    env: {},
    execFile: async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (args[0] === '--version') return { stdout: `${cmd} 1.0.0\n`, stderr: '', code: 0 };
      if (key === 'claude auth status --json') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', code: 0 };
      if (key === 'codex login status') return { stdout: '', stderr: 'Logged in using ChatGPT\n', code: 0 }; // real format: status on STDERR
      if (key === 'cursor-agent status --format json') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', code: 0 };
      if (key === 'cursor-agent models') return { stdout: CURSOR_CATALOG, stderr: '', code: 0 };
      if (key === 'agy models') return { stdout: AGY_CATALOG, stderr: '', code: 0 };
      throw new Error(`unexpected probe: ${key}`);
    },
    ...overrides,
  };
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const result = report.checks.find((entry) => entry.id === id);
  expect(result, `expected ${id}`).toBeDefined();
  return result!;
}

describe('runDoctor', () => {
  test('regression: healthy harnesses and configuration produce matching text and JSON summary counts', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.every((entry) => entry.outcome !== 'fail')).toBe(true);
    expect(formatDoctorReport(report)).toContain(`ok ${report.summary.ok}`);
    expect(JSON.parse(JSON.stringify(report)).summary).toEqual(report.summary);
  });

  test('regression: one missing CLI skips only its dependent probes and gives an installation hint', async () => {
    const deps = fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === '--version') {
        const error = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' });
        throw error;
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } });
    const report = await runDoctor({}, deps);
    expect(check(report, 'binary:cursor')).toMatchObject({ outcome: 'fail', hint: expect.stringContaining('cursor-agent') });
    expect(check(report, 'login:cursor')).toMatchObject({ outcome: 'skipped', detail: 'binary missing' });
    expect(check(report, 'catalog:cursor')).toMatchObject({ outcome: 'skipped', detail: 'binary missing' });
    expect(check(report, 'binary:claude').outcome).toBe('ok');
  });

  test('regression: a logged-out Claude session names the exact interactive recovery command', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'claude' && args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: false }), stderr: '', code: 1 };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:claude')).toMatchObject({ outcome: 'fail', hint: 'claude /login' });
  });

  test('regression: a route to a removed Cursor model identifies the affected task class', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'models') return { stdout: CURSOR_CATALOG.replace('cursor-grok-4.6-high-fast', 'other-model'), stderr: '', code: 0 };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'catalog:cursor')).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('cursor-work') });
  });

  test('regression: stale OpenAI-compatible verification warns without failing the diagnostic', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(check(report, 'freshness:groq')).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('last verified') });
    expect(report.exitCode).toBe(0);
  });

  test('regression: API keys are reported only as present and never leak into text or JSON', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { env: { GROQ_API_KEY: 'sk-live-SECRET123' } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).toContain('GROQ_API_KEY: present');
    expect(output).not.toContain('SECRET123');
  });

  test('regression: corrupt lanes fail their check while independent probes continue', async () => {
    const paths = config();
    writeFileSync(paths.lanes, 'floors: broken\n');
    const report = await runDoctor({}, fakeDeps(paths));
    expect(check(report, 'config:lanes').outcome).toBe('fail');
    expect(check(report, 'binary:claude').outcome).toBe('ok');
    expect(report.checks.length).toBeGreaterThan(10);
  });

  test('regression: provider filtering leaves non-Cursor harness probes out but retains configuration checks', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps());
    expect(report.checks.some((entry) => entry.provider === 'claude')).toBe(false);
    expect(report.checks.filter((entry) => entry.provider).every((entry) => entry.provider === 'cursor')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'config:routing')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'binary:cursor')).toBe(true);
  });

  test('regression: the default spawn runner closes stdin so a catalog probe cannot hang on an inherited pipe', async () => {
    const dir = resources.tempDir();
    const shim = join(dir, 'cursor-agent');
    writeFileSync(shim, '#!/bin/sh\ncat >/dev/null\necho ok\n');
    chmodSync(shim, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const started = Date.now();
      const report = await runDoctor({ provider: 'cursor' }, { paths: config() });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(check(report, 'binary:cursor')).toMatchObject({ outcome: 'ok', detail: 'ok' });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('regression: a probe timeout is unverified warning rather than a false broken-harness failure', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') return { stdout: '', stderr: '', code: null, timedOut: true };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:cursor')).toMatchObject({ outcome: 'warn', detail: 'timed out after 15s — unverified, not proven broken' });
    expect(report.exitCode).toBe(0);
  });

  test('regression: real Cursor and agy catalog layouts recognize their routed model ids', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(check(report, 'catalog:cursor').outcome).toBe('ok');
    expect(check(report, 'catalog:gemini').outcome).toBe('ok');
  });

  test('regression: Cursor unauthenticated JSON is logged out and names its recovery command', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') return { stdout: JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }), stderr: '', code: 0 };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:cursor')).toMatchObject({ outcome: 'fail', detail: 'logged out', hint: 'cursor-agent login' });
  });

  test('regression: login identity fields never leak from a successful status probe', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') return { stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true, email: 'leak@example.com' }), stderr: '', code: 0 };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).not.toContain('leak@example.com');
  });
  test('regression: codex reports its login status on stderr (verified 2026-08-28) and a logged-out codex names codex login', async () => {
    const loggedOut = await runDoctor({ provider: 'codex' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'codex' && args[0] === 'login') return { stdout: '', stderr: 'Not logged in\n', code: 1 };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(loggedOut, 'login:codex')).toMatchObject({ outcome: 'fail', detail: 'logged out', hint: 'codex login' });
    const loggedIn = await runDoctor({ provider: 'codex' }, fakeDeps());
    expect(check(loggedIn, 'login:codex')).toMatchObject({ outcome: 'ok', detail: 'logged in' });
  });
});
