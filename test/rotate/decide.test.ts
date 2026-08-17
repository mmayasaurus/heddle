import { describe, it, expect } from 'vitest';
import { decideRotation, DEFAULT_THRESHOLDS } from '../../src/rotate/decide.js';
import type { ClaudeAccount } from '../../src/capaware.js';
import type { ProviderCaps, AccountCaps } from '../../src/usage.js';

/**
 * Rotator decision layer (HED-117). The interesting cases are the ones that must NOT rotate: an
 * unknown reading (never rotate blind), and "the best account is the one we're on" (all accounts
 * near the cap → needs-human, not a self-rotate).
 */
describe('decideRotation', () => {
  const accounts: ClaudeAccount[] = [
    { id: 'acct1', configDir: '/h/.claude-acct1', loggedIn: true },
    { id: 'acct2', configDir: null, loggedIn: true }, // the default login
    { id: 'acct3', configDir: '/h/.claude-acct3', loggedIn: true },
  ];

  const acctCaps = (id: string, usedPct: number | null, stale = false): AccountCaps => ({
    id,
    fiveHour: { usedPercentage: usedPct ?? 0, resetsAt: 1_800_000_000 },
    sevenDay: { usedPercentage: 0, resetsAt: 1_800_000_000 },
    windows: {},
    noteCodes: [],
    limitReached: false,
    stale,
  });

  const caps = (rows: AccountCaps[]): ProviderCaps => ({
    provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1_700_000_000,
    fiveHour: { usedPercentage: 0, resetsAt: 0 }, sevenDay: { usedPercentage: 0, resetsAt: 0 },
    windows: {}, noteCodes: [], accounts: rows, activeAccount: null,
  });

  // Run "as acct1" (its configDir in the env) unless overridden.
  const envOn = (a: ClaudeAccount): NodeJS.ProcessEnv =>
    a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {};

  it('is idle well below the soft threshold', () => {
    const d = decideRotation(caps([acctCaps('acct1', 20)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('idle');
  });

  it('watches (no action) between soft and hard', () => {
    const d = decideRotation(caps([acctCaps('acct1', 85)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('watch');
  });

  it('rotates to the most-headroom OTHER account at/above hard', () => {
    const d = decideRotation(
      caps([acctCaps('acct1', 92), acctCaps('acct2', 10), acctCaps('acct3', 40)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.target.id).toBe('acct2');                 // most headroom
    expect(d.targetEnv.envUnset).toEqual(['CLAUDE_CONFIG_DIR']); // acct2 is the default login
    expect(d.reason).toMatch(/acct1.*→ acct2/);
  });

  it('produces the CLAUDE_CONFIG_DIR env for a non-default target', () => {
    const d = decideRotation(
      caps([acctCaps('acct1', 95), acctCaps('acct2', 90), acctCaps('acct3', 12)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.target.id).toBe('acct3');
    expect(d.targetEnv.env).toEqual({ CLAUDE_CONFIG_DIR: '/h/.claude-acct3' });
  });

  it('is EXHAUSTED, not a self-rotate, when the current account is still the best', () => {
    // Everyone is near the cap; acct1 (current) happens to have the most headroom of a bad lot.
    const d = decideRotation(
      caps([acctCaps('acct1', 91), acctCaps('acct2', 97), acctCaps('acct3', 95)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('exhausted');
    expect(d.reason).toMatch(/all Claude accounts are near the cap/i);
  });

  it('does NOT rotate on an unknown reading — a stale row is not 0%', () => {
    const d = decideRotation(caps([acctCaps('acct1', null, /*stale*/ true)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('unknown');
    expect(d.reason).toMatch(/no fresh 5h capture/);
  });

  it('does NOT rotate when there is no caps snapshot at all', () => {
    const d = decideRotation(undefined, accounts, envOn(accounts[0]!));
    expect(d.action).toBe('unknown');
  });

  it('reports unknown when the current account cannot be resolved', () => {
    // An env pointing at a config dir that is in no registry row.
    const d = decideRotation(caps([acctCaps('acct1', 95)]), accounts, { CLAUDE_CONFIG_DIR: '/h/.claude-nope' });
    expect(d.action).toBe('unknown');
    expect(d.current).toBeNull();
  });

  it('skips a logged-out account as a rotation target', () => {
    const withLoggedOut: ClaudeAccount[] = [
      accounts[0]!, { ...accounts[1]!, loggedIn: false }, accounts[2]!,
    ];
    const d = decideRotation(
      caps([acctCaps('acct1', 93), acctCaps('acct2', 5), acctCaps('acct3', 44)]),
      withLoggedOut, envOn(accounts[0]!),
    );
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.target.id).toBe('acct3');                 // acct2 has the most headroom but is logged out
  });


  it('does NOT rotate when the whole caps snapshot is provider-stale', () => {
    const stale = { ...caps([acctCaps('acct1', 95)]), stale: true };
    const d = decideRotation(stale, accounts, envOn(accounts[0]!));
    expect(d.action).toBe('unknown');
  });

  it('does NOT rotate when caps.source is none (nothing usable)', () => {
    const none = { ...caps([acctCaps('acct1', 95)]), source: 'none' as const };
    const d = decideRotation(none, accounts, envOn(accounts[0]!));
    expect(d.action).toBe('unknown');
  });

  it('is EXHAUSTED when the best OTHER account is itself over the hard cap', () => {
    // acct1 (current) 91%, acct2 90% is the best alternative but also over the 90% hard cap.
    const d = decideRotation(
      caps([acctCaps('acct1', 91), acctCaps('acct2', 90), acctCaps('acct3', 94)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('exhausted');
    expect(d.reason).toMatch(/best alternative acct2/);
  });

  it('honours custom thresholds', () => {
    const strict = { softPct: 50, hardPct: 60 };
    expect(decideRotation(caps([acctCaps('acct1', 55)]), accounts, envOn(accounts[0]!), strict).action).toBe('watch');
    expect(decideRotation(caps([acctCaps('acct1', 55)]), accounts, envOn(accounts[0]!), DEFAULT_THRESHOLDS).action).toBe('idle');
  });
});
