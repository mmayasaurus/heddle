import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLaunchSeat } from '../src/launch-seat.js';
import type { ClaudeAccount } from '../src/capaware.js';
import type { ClaudeFloors } from '../src/floors.js';
import type { ProviderCaps } from '../src/usage.js';
import type { Project, ProjectRegistry } from '../src/projects.js';
import { runCli, withTempHome } from './helpers/cli.js';

// Mirrors routing/lanes.yaml's ratified floors, so unit behaviour matches what the CLI loads live.
const floors: ClaudeFloors = { neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 };

// Every account has a NON-NULL configDir so a resolved seat is a real dir; the default-login (null)
// case is constructed explicitly in its own test.
const accounts = (count: number): ClaudeAccount[] => Array.from({ length: count }, (_, index) => ({
  id: `acct${index + 1}`, configDir: `/x/.claude-acct${index + 1}`,
}));

const caps = (rows: Array<{ id: string; used: number | null; stale?: boolean }>): ProviderCaps => ({
  provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1,
  fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
  windows: {}, noteCodes: [], activeAccount: null,
  accounts: rows.map(({ id, used, stale = false }) => ({
    id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
    windows: {}, noteCodes: [], limitReached: false, stale,
  })),
});

const project = (name: string, agentIds: string[]): Project => ({
  name, workspaceRoots: ['/x'], agentIds, linearTeam: 'HED', defaultRoom: `#${name}`, launcher: `${name}.sh`, tracker: 'linear',
});
const registry = (projects: Project[]): ProjectRegistry => ({ schemaVersion: 1, projects });

describe('resolveLaunchSeat — project-scoped seat resolution', () => {
  it('spreads a project\'s agents across DISTINCT accounts, deterministically per agent', () => {
    const reg = registry([project('proj', ['R', 'S', 'T', 'U'])]);
    const c = caps(accounts(4).map((account) => ({ id: account.id, used: 20 })));
    const seats = ['R', 'S', 'T', 'U'].map((agent) =>
      resolveLaunchSeat({ registry: reg, projectName: 'proj', agent, caps: c, accounts: accounts(4), floors }));
    expect(seats.every((seat) => seat.ok)).toBe(true);
    const dirs = seats.map((seat) => (seat.ok ? seat.configDir : null));
    expect(new Set(dirs).size).toBe(4); // one per account — a real spread, not four picks of the same

    // Called once per agent, the answer for a given agent never depends on call order.
    const again = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'R', caps: c, accounts: accounts(4), floors });
    expect(again.ok && again.configDir).toBe(seats[0].ok && seats[0].configDir);
  });

  it('FAILS LOUD when no account is eligible (all floored) — no configDir, a reason instead', () => {
    const reg = registry([project('proj', ['R'])]);
    const c = caps([{ id: 'acct1', used: 99 }, { id: 'acct2', used: 98 }]); // headroom 1% / 2% ≤ 3% floor
    const result = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'R', caps: c, accounts: accounts(2), floors });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('configDir');
    if (!result.ok) expect(result.reason).toMatch(/no Claude account seat.*floored/i);
  });

  it('FAILS LOUD when the agent is not in the project', () => {
    const reg = registry([project('proj', ['R', 'S'])]);
    const c = caps(accounts(2).map((account) => ({ id: account.id, used: 20 })));
    const result = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'Z', caps: c, accounts: accounts(2), floors });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/agent "Z" is not in project "proj"/);
  });

  it('FAILS LOUD when the project is not in the registry', () => {
    const reg = registry([project('proj', ['R'])]);
    const result = resolveLaunchSeat({ registry: reg, projectName: 'ghost', agent: 'R', caps: caps([]), accounts: accounts(1), floors });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/project "ghost" is not in the registry.*known: proj/);
  });

  it('FAILS LOUD when the resolved account is the default login (null configDir) — never a silent fallback', () => {
    const reg = registry([project('proj', ['R'])]);
    const defaultLogin: ClaudeAccount[] = [{ id: 'acct1', configDir: null }];
    const c = caps([{ id: 'acct1', used: 5 }]); // healthy + eligible, so the batch DOES place R here
    const result = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'R', caps: c, accounts: defaultLogin, floors });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('configDir');
    if (!result.ok) expect(result.reason).toMatch(/default login/i);
  });

  it('SUCCESS — resolves a healthy account to its configDir under the CANONICAL agent id (case-insensitive)', () => {
    const reg = registry([project('proj', ['R', 'S'])]);
    const c = caps([{ id: 'acct1', used: 10 }, { id: 'acct2', used: 20 }]);
    const result = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'r', caps: c, accounts: accounts(2), floors });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent).toBe('R'); // requested lowercase 'r' resolves to the registry's canonical 'R'
      expect(result.configDir).toMatch(/^\/x\/\.claude-acct[12]$/);
      expect(result.reason).toContain('batch placement');
    }
  });

  it('a weekly-floored account (7d, not 5h) is still not an eligible seat', () => {
    // Regression guard mirroring pickClaudeAccount PR#87: 7d headroom must gate the seat too.
    const reg = registry([project('proj', ['R'])]);
    const weekly: ProviderCaps = {
      ...caps([]), accounts: [{
        id: 'acct1', fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 98, resetsAt: null },
        windows: {}, noteCodes: [], limitReached: false, stale: false,
      }],
    };
    const result = resolveLaunchSeat({ registry: reg, projectName: 'proj', agent: 'R', caps: weekly, accounts: accounts(1), floors });
    expect(result.ok).toBe(false);
  });
});

// ── CLI process contract: stdout carries ONLY the configDir; failures put NOTHING on stdout ──────────
// These spawn `dist/cli.js` (runCli rebuilds it) with a temp HOME holding ~/.heddle/{projects,accounts}.json
// and a fresh limits.json. HEDDLE_CENSUS_PS_FIXTURE='[]' keeps any census hermetic; the seat command
// does not census, but it is set defensively so a live `claude` process can never leak in.
function seatHome(opts: {
  projects: unknown;
  accounts: Array<{ id: string; configDir?: string | null }>;
  caps: Array<{ id: string; used: number | null }>;
  writeLimits?: boolean; // default true; false → no caps mirror (tests the stale/missing-caps gate)
}): { home: string; env: Record<string, string> } {
  const home = withTempHome();
  const heddleDir = join(home, '.heddle');
  mkdirSync(heddleDir, { recursive: true });
  writeFileSync(join(heddleDir, 'projects.json'), JSON.stringify(opts.projects));
  writeFileSync(join(heddleDir, 'accounts.json'), JSON.stringify({ claude: opts.accounts }));
  const usageDir = join(home, 'usage');
  mkdirSync(usageDir, { recursive: true });
  if (opts.writeLimits !== false) {
    const nowS = Math.floor(Date.now() / 1000);
    writeFileSync(join(usageDir, 'limits.json'), JSON.stringify({
      writtenAt: nowS,
      limits: [{
        provider: 'claude', capturedAt: nowS, staleAfterSecs: 900,
        accounts: opts.caps.map(({ id, used }) => ({ id, fiveHour: { usedPercentage: used }, sevenDay: {} })),
      }],
    }));
  }
  return { home, env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_CENSUS_PS_FIXTURE: '[]' } };
}

const cliProject = (name: string, agentIds: string[]) => ({
  schemaVersion: 1,
  projects: [{ name, workspaceRoots: ['/tmp/heddle-seat-test'], agentIds, linearTeam: 'HED', defaultRoom: `#${name}`, launcher: `${name}.sh` }],
});

describe('heddle account seat — CLI stdout/stderr/exit contract', () => {
  it('SUCCESS: configDir alone on stdout, a binding line on stderr, exit 0', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R']),
      accounts: [{ id: 'acct1', configDir: '/x/.claude-acct1' }, { id: 'acct2', configDir: '/x/.claude-acct2' }],
      caps: [{ id: 'acct1', used: 5 }, { id: 'acct2', used: 50 }], // acct1 has the most headroom
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj', 'R'], { home, env });
    expect(code).toBe(0);
    expect(stdout).toBe('/x/.claude-acct1\n'); // ONLY the configDir, so CLAUDE_CONFIG_DIR=$(…) is clean
    expect(stderr).toContain('seat R@proj');
    expect(stderr).toContain('acct1');
  });

  it('FAIL LOUD (no eligible account): NOTHING on stdout, reason on stderr, non-zero exit', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R']),
      accounts: [{ id: 'acct1', configDir: '/x/.claude-acct1' }, { id: 'acct2', configDir: '/x/.claude-acct2' }],
      caps: [{ id: 'acct1', used: 99 }, { id: 'acct2', used: 98 }], // both floored
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj', 'R'], { home, env });
    expect(code).not.toBe(0);
    expect(stdout).toBe(''); // NEVER a fallback configDir
    expect(stderr).toMatch(/floored/i);
  });

  it('FAIL LOUD (agent not in project): nothing on stdout, exit non-zero', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R', 'S']),
      accounts: [{ id: 'acct1', configDir: '/x/.claude-acct1' }],
      caps: [{ id: 'acct1', used: 5 }],
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj', 'Z'], { home, env });
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/not in project "proj"/);
  });

  it('FAIL LOUD (default-login / null configDir): nothing on stdout, exit non-zero', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R']),
      accounts: [{ id: 'acct1' }], // no configDir → the default login
      caps: [{ id: 'acct1', used: 5 }],
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj', 'R'], { home, env });
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/default login/i);
  });

  it('exit 2 on missing arguments, nothing on stdout', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R']),
      accounts: [{ id: 'acct1', configDir: '/x/.claude-acct1' }],
      caps: [{ id: 'acct1', used: 5 }],
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj'], { home, env });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('usage: heddle account seat');
  });

  it('exit 2 when caps are missing/stale (refuses to guess a seat), nothing on stdout', async () => {
    const { home, env } = seatHome({
      projects: cliProject('proj', ['R']),
      accounts: [{ id: 'acct1', configDir: '/x/.claude-acct1' }],
      caps: [],
      writeLimits: false, // no limits.json → caps unusable
    });
    const { stdout, stderr, code } = await runCli(['account', 'seat', 'proj', 'R'], { home, env });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/caps are missing or stale/i);
  });
});
