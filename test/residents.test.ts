import { describe, expect, it, vi } from 'vitest';
import { censusClaudeResidents } from '../src/residents.js';

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
});
