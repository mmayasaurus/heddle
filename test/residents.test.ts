import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { censusClaudeLogins, censusClaudeResidents } from '../src/residents.js';
import { useTempResources } from './helpers.js';

const { tempDir } = useTempResources('heddle-residents-test-');

const accounts = [
  { id: 'default', configDir: null },
  { id: 'other', configDir: '/accounts/other' },
];
const weightOf = (letter: string) => (letter === 'R' ? 2.5 : 1);

/** One `ps eww` payload: the header line the census drops, then the env-bearing command row. */
const psOutput = (pid: string, command: string) => `  PID TTY      STAT   TIME COMMAND\n  ${pid} ??       S      0:00 ${command}\n`;

/** A pgrep/ps exec double: `pgrep -x claude` → pids, `ps eww <pid>` → that pid's row. */
const execFrom = (pids: string[], commandByPid: Record<string, string>) => (file: string, args: string[]): string => {
  if (file === 'pgrep') return pids.join('\n') + '\n';
  if (file === 'ps') return psOutput(args[1]!, commandByPid[args[1]!] ?? 'claude');
  throw new Error(`unexpected exec: ${file}`);
};

describe('censusClaudeResidents', () => {
  it('aggregates interactive sessions by account, weights by HEDDLE_AGENT, and excludes headless/companion/snapshot', () => {
    const result = censusClaudeResidents({
      accounts, weightOf,
      exec: execFrom(['101', '103', '104', '105', '106', '107'], {
        101: 'claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/accounts/other',
        103: 'claude HEDDLE_AGENT=S',                                        // env-less config dir → default
        104: 'claude -p task HEDDLE_AGENT=X CLAUDE_CONFIG_DIR=/accounts/other', // headless worker → skip
        105: 'claude HEDDLE_AGENT=Y CODEX_COMPANION=1 CLAUDE_CONFIG_DIR=/accounts/other', // codex companion → skip
        106: 'claude --shell-snapshot /tmp/s HEDDLE_AGENT=Z',                  // captured shell snapshot → skip
        107: 'claude HEDDLE_AGENT=T CLAUDE_CONFIG_DIR=/accounts/other',        // second seat on the same account
      }),
    });
    // Two seats on `other` (R+T) sum by weight; letters are only the weight index, aggregation is by account.
    expect(result).toEqual(new Map([
      ['other', { count: 2, weight: 3.5 }],
      ['default', { count: 1, weight: 1 }],
    ]));
  });

  it('counts an env-less interactive session as a 1.0 seat on the single default account', () => {
    const result = censusClaudeResidents({ accounts, weightOf, exec: execFrom(['201'], { 201: 'claude' }) });
    expect(result).toEqual(new Map([['default', { count: 1, weight: 1 }]]));
  });

  it('returns null (never a partial count) when a session maps to no account', () => {
    const warnings: string[] = [];
    const result = censusClaudeResidents({
      accounts, weightOf, stderr: { write: (m: string) => (warnings.push(m), true) },
      exec: execFrom(['301'], { 301: 'claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/accounts/unknown' }),
    });
    expect(result).toBeNull();
    expect(warnings.join('')).toMatch(/warning: .*resident census unavailable/i);
  });

  it('returns null for an env-less session when there is not exactly one default account', () => {
    const twoDefaults = [{ id: 'd1', configDir: null }, { id: 'd2', configDir: null }];
    const result = censusClaudeResidents({ accounts: twoDefaults, weightOf, exec: execFrom(['401'], { 401: 'claude' }) });
    expect(result).toBeNull();
  });

  it('treats no interactive claude processes (pgrep status 1) as an authoritative empty, without warning', () => {
    const warnings: string[] = [];
    const result = censusClaudeResidents({
      accounts, weightOf, stderr: { write: (m: string) => (warnings.push(m), true) },
      exec: () => { throw Object.assign(new Error('no match'), { status: 1 }); },
    });
    expect(result).toEqual(new Map());
    expect(warnings).toEqual([]);
  });

  it('treats an all-skipped process set as an authoritative empty', () => {
    const result = censusClaudeResidents({ accounts, weightOf, exec: execFrom(['601'], { 601: 'claude -p task HEDDLE_AGENT=R' }) });
    expect(result).toEqual(new Map());
  });

  it('returns null and warns when the census mechanism fails (not a status-1 empty)', () => {
    const warnings: string[] = [];
    const result = censusClaudeResidents({
      accounts, weightOf, stderr: { write: (m: string) => (warnings.push(m), true) },
      exec: () => { throw new Error('sandbox denied pgrep'); },
    });
    expect(result).toBeNull();
    expect(warnings.join('')).toMatch(/warning: .*resident census unavailable/i);
  });

  it('honors the shared HEDDLE_CENSUS_PS_FIXTURE lines, bypassing pgrep/ps entirely', () => {
    const exec = vi.fn(() => { throw new Error('exec must not run when a fixture is supplied'); });
    const psLines = ['claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/accounts/other', 'claude HEDDLE_AGENT=S'];
    const viaDep = censusClaudeResidents({ accounts, weightOf, psLines, exec });
    const viaEnv = censusClaudeResidents({ accounts, weightOf, env: { HEDDLE_CENSUS_PS_FIXTURE: JSON.stringify(psLines) }, exec });
    const expected = new Map([['other', { count: 1, weight: 2.5 }], ['default', { count: 1, weight: 1 }]]);
    expect(viaDep).toEqual(expected);
    expect(viaEnv).toEqual(expected);
    expect(exec).not.toHaveBeenCalled();
  });

  it('attributes by exact config dir — never a same-basename neighbour — and invalidates an unlisted or non-unique dir', () => {
    // Two accounts share basename `.claude`. A session on y must attribute to y (a basename matcher would
    // have taken the first match, x); a session on an UNLISTED same-basename dir must invalidate (null),
    // not silently mis-map (codeant HED-514).
    const collided = [{ id: 'x', configDir: '/home/x/.claude' }, { id: 'y', configDir: '/home/y/.claude' }];
    expect(censusClaudeResidents({
      accounts: collided, weightOf, exec: execFrom(['701'], { 701: 'claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/home/y/.claude' }),
    })).toEqual(new Map([['y', { count: 1, weight: 2.5 }]]));

    const warnings: string[] = [];
    expect(censusClaudeResidents({
      accounts: collided, weightOf, stderr: { write: (m: string) => (warnings.push(m), true) },
      exec: execFrom(['702'], { 702: 'claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/home/z/.claude' }),
    })).toBeNull();
    expect(warnings.join('')).toMatch(/maps to no single account/);

    // Two registry rows on the SAME normalized dir → a matched session is ambiguous, never the first row.
    const dup = [{ id: 'a', configDir: '/home/dup/.claude' }, { id: 'b', configDir: '/home/dup/.claude' }];
    expect(censusClaudeResidents({
      accounts: dup, weightOf, stderr: { write: () => true },
      exec: execFrom(['703'], { 703: 'claude CLAUDE_CONFIG_DIR=/home/dup/.claude' }),
    })).toBeNull();
  });

  it('normalizes a trailing slash so a session dir still matches its registry entry', () => {
    expect(censusClaudeResidents({
      accounts, weightOf, exec: execFrom(['801'], { 801: 'claude HEDDLE_AGENT=S CLAUDE_CONFIG_DIR=/accounts/other/' }),
    })).toEqual(new Map([['other', { count: 1, weight: 1 }]]));
  });
});

describe('censusClaudeLogins', () => {
  // The live registry's shape: acct2 and acct4 are two folders logged into one login, and the default
  // folder (no registry row) is logged into acct1's.
  const registry = [
    { id: 'acct1', configDir: '/accounts/acct1', accountUuid: 'LOGIN-1' },
    { id: 'acct2', configDir: '/accounts/acct2', accountUuid: 'LOGIN-2' },
    { id: 'acct4', configDir: '/accounts/acct4', accountUuid: 'LOGIN-2' },
  ];
  const homeLoggedInto = (accountUuid: string) => {
    const home = tempDir();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid } }));
    return home;
  };

  it('adds up folders sharing a login, and counts an env-less session toward the default folder\'s login', () => {
    const result = censusClaudeLogins({
      accounts: registry, weightOf, home: homeLoggedInto('LOGIN-1'),
      psLines: [
        'claude HEDDLE_AGENT=R CLAUDE_CONFIG_DIR=/accounts/acct2',
        'claude CLAUDE_CONFIG_DIR=/accounts/acct4/',
        'claude HEDDLE_AGENT=S',
        'claude -p task HEDDLE_AGENT=X CLAUDE_CONFIG_DIR=/accounts/acct2', // headless worker → skip
      ],
    });
    expect(result).toEqual(new Map([
      ['uuid:LOGIN-2', { count: 2, weight: 3.5 }],
      ['uuid:LOGIN-1', { count: 1, weight: 1 }],
    ]));
  });

  it('counts a session in a folder the registry doesn\'t list by that folder\'s own .claude.json', () => {
    const folder = join(tempDir(), '.claude-spare');
    mkdirSync(folder);
    writeFileSync(join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'SPARE' } }));
    expect(censusClaudeLogins({
      accounts: registry, weightOf, home: homeLoggedInto('LOGIN-1'), psLines: [`claude CLAUDE_CONFIG_DIR=${folder}`],
    })).toEqual(new Map([['uuid:SPARE', { count: 1, weight: 1 }]]));
  });

  it('returns null (never a partial count) when a session\'s login can\'t be told', () => {
    const warnings: string[] = [];
    const result = censusClaudeLogins({
      accounts: registry, weightOf, home: homeLoggedInto('LOGIN-1'), stderr: { write: (m: string) => (warnings.push(m), true) },
      psLines: ['claude CLAUDE_CONFIG_DIR=/accounts/acct2', 'claude CLAUDE_CONFIG_DIR=/accounts/unknown'],
    });
    expect(result).toBeNull();
    expect(warnings.join('')).toMatch(/resident census unavailable.*can't be told/);
  });

  it('returns null for an env-less session when the default folder holds no login', () => {
    const home = tempDir();
    expect(censusClaudeLogins({ accounts: registry, weightOf, home, stderr: { write: () => true }, psLines: ['claude'] })).toBeNull();
  });

  it('treats no interactive sessions as an authoritative empty', () => {
    expect(censusClaudeLogins({ accounts: registry, weightOf, psLines: [] })).toEqual(new Map());
    expect(censusClaudeLogins({ accounts: registry, weightOf, psLines: ['claude -p task'] })).toEqual(new Map());
  });
});
