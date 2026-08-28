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
      if (args[0] === '--version') return { stdout: `${cmd} 1.0.0\n`, stderr: '', exitCode: 0, timedOut: false };
      if (key === 'claude auth status --json') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false };
      if (key === 'codex login status') return { stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0, timedOut: false }; // real format: status on STDERR
      if (key === 'cursor-agent status --format json') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false };
      if (key === 'cursor-agent models') return { stdout: CURSOR_CATALOG, stderr: '', exitCode: 0, timedOut: false };
      if (key === 'agy models') return { stdout: AGY_CATALOG, stderr: '', exitCode: 0, timedOut: false };
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
    expect(report.summary.ok + report.summary.warn + report.summary.fail + report.summary.skipped).toBe(report.checks.length);
    expect(formatDoctorReport(report).split('\n')).toHaveLength(report.checks.length + 2);
  });

  test('regression: one missing CLI skips only its dependent probes and gives an installation hint', async () => {
    const deps = fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === '--version') return { stdout: '', stderr: 'spawn error: Error: ENOENT', exitCode: null, timedOut: false };
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
      if (cmd === 'claude' && args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: false }), stderr: '', exitCode: 1, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:claude')).toMatchObject({ outcome: 'fail', hint: 'claude /login' });
  });

  test('regression: a route to a removed Cursor model identifies the affected task class', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'models') return { stdout: CURSOR_CATALOG.replace('cursor-grok-4.6-high-fast', 'other-model'), stderr: '', exitCode: 0, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'catalog:cursor')).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('cursor-work') });
  });

  test('regression: stale OpenAI-compatible verification warns without failing the diagnostic', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(check(report, 'freshness:groq')).toMatchObject({ outcome: 'warn', detail: expect.stringContaining('last verified') });
    expect(report.exitCode).toBe(0);
  });

  test('regression: secrets-file keys are reported only as present and never leak into text or JSON', async () => {
    const paths = config();
    const secrets = join(resources.tempDir(), 'secrets.env');
    writeFileSync(secrets, 'GROQ_API_' + 'KEY="fakefakefakefake"\n');
    const report = await runDoctor({}, fakeDeps(paths, { paths: { ...paths, secrets } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).toContain('GROQ_API_KEY: present in secrets.env');
    expect(output).not.toContain('fakefakefakefake');
  });

  test('regression: corrupt lanes fail their check while independent probes continue', async () => {
    const paths = config();
    writeFileSync(paths.lanes, 'floors: broken\n');
    const report = await runDoctor({}, fakeDeps(paths));
    expect(check(report, 'config:lanes').outcome).toBe('fail');
    expect(check(report, 'binary:claude').outcome).toBe('ok');
    expect(report.checks.filter((entry) => entry.outcome === 'fail')).toHaveLength(1);
    expect(report.checks.filter((entry) => entry.kind === 'freshness').every((entry) => entry.outcome === 'skipped')).toBe(true);
  });

  test('regression: provider filtering leaves non-Cursor harness probes out but retains configuration checks', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps());
    expect(report.checks.some((entry) => entry.provider === 'claude')).toBe(false);
    expect(report.checks.filter((entry) => entry.provider).every((entry) => entry.provider === 'cursor')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'config:routing')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'binary:cursor')).toBe(true);
  });

  test('regression: a real stuck cursor-agent binary probe times out instead of hanging doctor', async () => {
    const dir = resources.tempDir();
    const shim = join(dir, 'cursor-agent');
    // Hang ONLY on --version (a SIGKILLed sh leaves its `sleep` child holding the pipes, which is the
    // grandchild case the grace deadline exists for); answer the login/catalog probes instantly so the
    // run's wall time measures the binary check alone.
    writeFileSync(shim, "#!/bin/sh\ncase \"$1\" in\n  --version) trap '' TERM; sleep 5 ;;\n  *) echo '{\"isAuthenticated\":true}' ;;\nesac\n");
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
  }, 1_000);

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

  test('regression: real Cursor and agy catalog layouts recognize their routed model ids', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(check(report, 'catalog:cursor').outcome).toBe('ok');
    expect(check(report, 'catalog:gemini').outcome).toBe('ok');
  });

  test('regression: an absent Gemini model warns because the agy catalog can lag', async () => {
    const report = await runDoctor(
      {},
      fakeDeps(undefined, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'agy' && args[0] === 'models') {
            return {
              stdout: AGY_CATALOG.replace('gemini-3.7-flash-high', 'other-model'),
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(report, 'catalog:gemini')).toMatchObject({
      outcome: 'warn',
      detail: expect.stringContaining('gemini-work: gemini-3.7-flash-high not listed'),
    });
    expect(report.exitCode).toBe(0);
  });

  test('regression: Cursor unauthenticated JSON is logged out and names its recovery command', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') return { stdout: JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }), stderr: '', exitCode: 0, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:cursor')).toMatchObject({ outcome: 'fail', detail: 'logged out', hint: 'cursor-agent login' });
  });

  test('regression: login identity fields never leak from a successful status probe', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') return { stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true, email: 'leak@example.com' }), stderr: '', exitCode: 0, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).not.toContain('leak@example.com');
  });
  test('regression: codex reports its login status on stderr (verified 2026-08-28) and a logged-out codex names codex login', async () => {
    const loggedOut = await runDoctor({ provider: 'codex' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'codex' && args[0] === 'login') return { stdout: '', stderr: 'Not logged in\n', exitCode: 1, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(loggedOut, 'login:codex')).toMatchObject({ outcome: 'fail', detail: 'logged out', hint: 'codex login' });
    const loggedIn = await runDoctor({ provider: 'codex' }, fakeDeps());
    expect(check(loggedIn, 'login:codex')).toMatchObject({ outcome: 'ok', detail: 'logged in' });
  });

  test('regression: recognized login JSON wins over a non-zero exit while garbage remains unverified', async () => {
    const recognized = await runDoctor({ provider: 'claude' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'claude' && args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 1, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(recognized, 'login:claude')).toMatchObject({ outcome: 'ok', detail: 'logged in' });
    const unknown = await runDoctor({ provider: 'claude' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'claude' && args[0] === 'auth') return { stdout: 'crashed', stderr: '', exitCode: 1, timedOut: false };
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(unknown, 'login:claude')).toMatchObject({ outcome: 'warn', detail: 'unrecognized status output (exit 1)' });
  });

  test('regression: HEDDLE_ACCOUNTS selects the same registry path as account consumers', async () => {
    const paths = config();
    const accounts = join(resources.tempDir(), 'accounts.json');
    writeFileSync(accounts, JSON.stringify({ claude: [{ id: 'one', configDir: null }, { id: 'two', configDir: '/tmp/two' }] }));
    const report = await runDoctor({}, fakeDeps(paths, { paths: { routing: paths.routing, lanes: paths.lanes, projects: paths.projects }, env: { HEDDLE_ACCOUNTS: accounts } }));
    expect(check(report, 'config:claude-accounts')).toMatchObject({ outcome: 'ok', detail: '2 Claude accounts; 2 logged in' });
  });

  test('regression: blank HEDDLE_ROUTING falls through to the default routing table', async () => {
    const paths = config();
    const report = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        paths: { lanes: paths.lanes, projects: paths.projects, accounts: paths.accounts },
        env: { HEDDLE_ROUTING: '' },
      }),
    );
    expect(check(report, 'config:routing').outcome).toBe('ok');
  });

  test('regression: present malformed Claude registries fail rather than silently using inherited login', async () => {
    const paths = config();
    writeFileSync(paths.accounts, '{not json');
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({ outcome: 'fail', detail: 'accounts.json is not valid JSON' });
    writeFileSync(paths.accounts, JSON.stringify({ claude: 'nope' }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({ outcome: 'fail', detail: 'accounts.json has no claude[] array' });
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{}] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({
      outcome: 'fail',
      detail: 'accounts.json has 1 malformed claude[] row(s) (each needs a string id; configDir must be a string)',
      hint: 'fix the file',
    });
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ configDir: '/tmp/a' }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts').outcome).toBe('fail');
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ id: 'a', configDir: 5 }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts').outcome).toBe('fail');
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ id: 'a', configDir: null }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({
      outcome: 'ok',
      detail: '1 Claude account; 1 logged in',
    });
  });

  test('regression: unknown providers reject before probes while groq runs freshness plus global config', async () => {
    await expect(runDoctor({ provider: 'cursr' }, fakeDeps())).rejects.toThrow('unknown provider "cursr" — known:');
    const report = await runDoctor({ provider: 'groq' }, fakeDeps());
    expect(report.checks.filter((entry) => entry.provider).map((entry) => entry.provider)).toEqual(['groq']);
    expect(report.checks.some((entry) => entry.id === 'config:routing')).toBe(true);
  });

  test('regression: failed catalog streams cannot leak a token or identity into the report', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'models') {
        return {
          stdout: '',
          stderr: 'token=fakefakefakefake email=leak@example.com',
          exitCode: 1,
          timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).not.toContain('fakefakefakefake');
    expect(output).not.toContain('leak@example.com');
  });
});
