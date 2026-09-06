import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatDoctorReport, runDoctor } from '../src/doctor.js';
import {
  AGY_CATALOG,
  check,
  config,
  CURSOR_CATALOG,
  fakeDeps,
  resources,
} from './doctor-fixtures.js';

describe('runDoctor', () => {
  test('regression: healthy harnesses and configuration produce matching text and JSON summary counts', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.every((entry) => entry.outcome !== 'fail')).toBe(true);
    expect(formatDoctorReport(report)).toContain(`ok ${report.summary.ok}`);
    expect(JSON.parse(JSON.stringify(report)).summary).toEqual(report.summary);
    expect(
      report.summary.ok + report.summary.warn + report.summary.fail + report.summary.skipped,
    ).toBe(report.checks.length);
    expect(formatDoctorReport(report).split('\n')).toHaveLength(report.checks.length + 2);
  });

  test('regression: Cursor lane-default models absent from the catalog name their lane', async () => {
    const paths = config(undefined, {
      laneDefaults: '  cursor:\n    provider: cursor\n    model: cursor-lane-default',
    });
    const missing = await runDoctor({ provider: 'cursor' }, fakeDeps(paths));
    expect(check(missing, 'catalog:cursor')).toMatchObject({
      outcome: 'fail',
      detail: expect.stringContaining('lane-default:cursor: cursor-lane-default'),
    });
    const listed = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        execFile: async (cmd, args, opts) => {
          if (cmd === 'cursor-agent' && args[0] === 'models') {
            return {
              stdout: `${CURSOR_CATALOG}cursor-lane-default - Lane default\n`,
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          return fakeDeps().execFile!(cmd, args, opts);
        },
      }),
    );
    expect(check(listed, 'catalog:cursor').outcome).toBe('ok');
  });

  test('regression: one missing CLI skips only its dependent probes and gives an installation hint', async () => {
    const deps = fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === '--version') {
        return {
          stdout: '', stderr: 'spawn error: Error: ENOENT', exitCode: null, timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } });
    const report = await runDoctor({}, deps);
    expect(check(report, 'binary:cursor')).toMatchObject({
      outcome: 'fail', hint: expect.stringContaining('cursor-agent'),
    });
    expect(check(report, 'login:cursor')).toMatchObject({ outcome: 'skipped', detail: 'binary missing' });
    expect(check(report, 'catalog:cursor')).toMatchObject({ outcome: 'skipped', detail: 'binary missing' });
    expect(check(report, 'binary:claude').outcome).toBe('ok');
  });

  test('regression: a logged-out Claude session names the exact interactive recovery command', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'claude' && args[0] === 'auth') {
        return {
          stdout: JSON.stringify({ loggedIn: false }), stderr: '', exitCode: 1, timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:claude')).toMatchObject({ outcome: 'fail', hint: 'claude /login' });
  });

  test('regression: a route to a removed Cursor model identifies the affected task class', async () => {
    const report = await runDoctor({}, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'models') {
        return {
          stdout: CURSOR_CATALOG.replace('cursor-grok-4.6-high-fast', 'other-model'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'catalog:cursor')).toMatchObject({
      outcome: 'fail', detail: expect.stringContaining('cursor-work'),
    });
  });

  test('regression: stale OpenAI-compatible verification warns without failing the diagnostic', async () => {
    const report = await runDoctor({}, fakeDeps());
    expect(check(report, 'freshness:groq')).toMatchObject({
      outcome: 'warn', detail: expect.stringContaining('last verified'),
    });
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
    expect(
      report.checks
        .filter((entry) => entry.kind === 'freshness')
        .every((entry) => entry.outcome === 'skipped'),
    ).toBe(true);
  });

  test(
    'regression: provider filtering leaves non-Cursor harness probes out but retains configuration checks',
    async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps());
    expect(report.checks.some((entry) => entry.provider === 'claude')).toBe(false);
    expect(report.checks.filter((entry) => entry.provider).every((entry) => entry.provider === 'cursor')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'config:routing')).toBe(true);
    expect(report.checks.some((entry) => entry.id === 'binary:cursor')).toBe(true);
    },
  );

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
      if (cmd === 'cursor-agent' && args[0] === 'status') {
        return {
          stdout: JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(report, 'login:cursor')).toMatchObject({
      outcome: 'fail', detail: 'logged out', hint: 'cursor-agent login',
    });
  });

  test('regression: login identity fields never leak from a successful status probe', async () => {
    const report = await runDoctor({ provider: 'cursor' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'cursor-agent' && args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            status: 'authenticated', isAuthenticated: true, email: 'leak@example.com',
          }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(output).not.toContain('leak@example.com');
  });

  test('regression: inherited Cursor credentials are reported as ignored without leaking their value', async () => {
    const report = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(undefined, { env: { CURSOR_API_KEY: 'fakefakefakefake' } }),
    );
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    expect(check(report, 'login:cursor').detail).toContain('inherited CURSOR_API_KEY ignored');
    expect(output).not.toContain('fakefakefakefake');
  });
  test(
    'regression: codex reports its login status on stderr (verified 2026-08-28) '
      + 'and a logged-out codex names codex login',
    async () => {
    const loggedOut = await runDoctor(
      { provider: 'codex' },
      fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
        if (cmd === 'codex' && args[0] === 'login') {
          return {
            stdout: '', stderr: 'Not logged in\n', exitCode: 1, timedOut: false,
          };
        }
        return fakeDeps().execFile!(cmd, args, opts);
      } }),
    );
    expect(check(loggedOut, 'login:codex')).toMatchObject({
      outcome: 'fail', detail: 'logged out', hint: 'codex login',
    });
    const loggedIn = await runDoctor({ provider: 'codex' }, fakeDeps());
    expect(check(loggedIn, 'login:codex')).toMatchObject({ outcome: 'ok', detail: 'logged in' });
    },
  );

  test('regression: recognized login JSON wins over a non-zero exit while garbage remains unverified', async () => {
    const recognized = await runDoctor(
      { provider: 'claude' },
      fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
        if (cmd === 'claude' && args[0] === 'auth') {
          return {
            stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 1, timedOut: false,
          };
        }
        return fakeDeps().execFile!(cmd, args, opts);
      } }),
    );
    expect(check(recognized, 'login:claude')).toMatchObject({ outcome: 'ok', detail: 'logged in' });
    const unknown = await runDoctor({ provider: 'claude' }, fakeDeps(undefined, { execFile: async (cmd, args, opts) => {
      if (cmd === 'claude' && args[0] === 'auth') {
        return { stdout: 'crashed', stderr: '', exitCode: 1, timedOut: false };
      }
      return fakeDeps().execFile!(cmd, args, opts);
    } }));
    expect(check(unknown, 'login:claude')).toMatchObject({
      outcome: 'warn', detail: 'unrecognized status output (exit 1)',
    });
  });

  test('regression: HEDDLE_ACCOUNTS selects the same registry path as account consumers', async () => {
    const paths = config();
    const accounts = join(resources.tempDir(), 'accounts.json');
    writeFileSync(accounts, JSON.stringify({
      claude: [{ id: 'one', configDir: null }, { id: 'two', configDir: '/tmp/two' }],
    }));
    const report = await runDoctor(
      {},
      fakeDeps(paths, {
        paths: { routing: paths.routing, lanes: paths.lanes, projects: paths.projects },
        env: { HEDDLE_ACCOUNTS: accounts },
      }),
    );
    expect(check(report, 'config:claude-accounts')).toMatchObject({
      outcome: 'ok', detail: '2 Claude accounts; 2 logged in',
    });
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

  test('regression: blank HEDDLE_LANES falls through to the default lanes configuration', async () => {
    const paths = config();
    const report = await runDoctor(
      { provider: 'cursor' },
      fakeDeps(paths, {
        paths: { routing: paths.routing, projects: paths.projects, accounts: paths.accounts },
        env: { HEDDLE_LANES: '' },
      }),
    );
    expect(check(report, 'config:lanes').outcome).toBe('ok');
  });

  test('regression: a present project registry reports its registered project count', async () => {
    const paths = config();
    writeFileSync(paths.projects, JSON.stringify({
      schemaVersion: 1,
      projects: [{
        name: 'test', workspaceRoots: [resources.tempDir()], agentIds: ['A'], linearTeam: 'HED',
        defaultRoom: 'test-room', launcher: 'test-launcher',
      }],
    }));
    const report = await runDoctor({}, fakeDeps(paths));
    expect(check(report, 'config:projects')).toMatchObject({ outcome: 'ok', detail: '1 project registered' });
  });

  test('regression: present malformed Claude registries fail rather than silently using inherited login', async () => {
    const paths = config();
    writeFileSync(paths.accounts, '{not json');
    expect(
      check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts'),
    ).toMatchObject({ outcome: 'fail', detail: 'accounts.json is not valid JSON' });
    writeFileSync(paths.accounts, JSON.stringify({ claude: 'nope' }));
    expect(
      check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts'),
    ).toMatchObject({ outcome: 'fail', detail: 'accounts.json has no claude[] array' });
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{}] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({
      outcome: 'fail',
      detail: 'accounts.json has 1 malformed claude[] row(s) '
        + '(each needs a string id; configDir string or null; loggedIn boolean)',
      hint: 'fix the file',
    });
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ configDir: '/tmp/a' }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts').outcome).toBe('fail');
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ id: 'a', configDir: 5 }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts').outcome).toBe('fail');
    writeFileSync(paths.accounts, JSON.stringify({ claude: [{ id: 'a', loggedIn: 'false' }] }));
    expect(check(await runDoctor({}, fakeDeps(paths)), 'config:claude-accounts')).toMatchObject({
      outcome: 'fail', detail: expect.stringContaining('1 malformed claude[] row'),
    });
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
