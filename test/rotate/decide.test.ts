import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideRotation, readAndDecide, DEFAULT_THRESHOLDS } from '../../src/rotate/decide.js';
import { useTempResources } from '../helpers.js';
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

  const acctCaps = (id: string, usedPct: number | null, stale = false, sevenDayPct: number | null = 0): AccountCaps => ({
    id,
    fiveHour: { usedPercentage: usedPct ?? 0, resetsAt: 1_800_000_000 },
    sevenDay: { usedPercentage: sevenDayPct, resetsAt: 1_800_000_000 },
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

  it('does NOT rotate on a tap-only snapshot with no authoritative active account (codex P1)', () => {
    // Mirror absent/stale → readProviderCaps yields source:'claude-tap' + activeAccount:null. The only
    // derivable "current" would be the rotator daemon's OWN env account, unrelated to the fleet — acting
    // on it could pause/kill the WRONG account. Must be unknown, never a rotate.
    const tapOnly = { ...caps([acctCaps('acct1', 95), acctCaps('acct2', 10)]), source: 'claude-tap' as const, activeAccount: null };
    const d = decideRotation(tapOnly, accounts, envOn(accounts[0]!)); // env points at acct1 (95%)
    expect(d.action).toBe('unknown');
    expect(d.reason).toMatch(/no authoritative active account/i);
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


  it('reads the CURRENT account from the tap activeAccount, not the rotator process env', () => {
    // The rotator process env points at acct1's dir, but the tap says the FLEET is active on acct3.
    const c = { ...caps([acctCaps('acct1', 20), acctCaps('acct3', 95), acctCaps('acct2', 10)]), activeAccount: 'acct3' };
    const d = decideRotation(c, accounts, { CLAUDE_CONFIG_DIR: '/h/.claude-acct1' });
    // Decision is about acct3 (the fleet's account, 95%), not acct1 (the rotator's env, 20%).
    expect(d.current).toBe('acct3');
    expect(d.action).toBe('rotate');
  });

  it('honours custom thresholds', () => {
    const strict = { ...DEFAULT_THRESHOLDS, softPct: 50, hardPct: 60 };
    expect(decideRotation(caps([acctCaps('acct1', 55)]), accounts, envOn(accounts[0]!), strict).action).toBe('watch');
    expect(decideRotation(caps([acctCaps('acct1', 55)]), accounts, envOn(accounts[0]!), DEFAULT_THRESHOLDS).action).toBe('idle');
  });

  // HED-190: the rotator must also trigger on the WEEKLY (7-day) cap. The window-keeper's staggering
  // keeps 5h healthy while the weekly climbs, so a 5h-only trigger never fires for this case.
  it('rotates on the WEEKLY (7d) hard cap even though 5h is healthy — the real HED-190 case', () => {
    // Shape of the real incident (5h 22%, 7d climbing toward the cap): 7d must independently reach
    // the hard band to force a rotate, since DEFAULT_THRESHOLDS.hard7dPct is 90.
    const d = decideRotation(
      caps([acctCaps('acct1', 22, false, 92), acctCaps('acct2', 10, false, 20), acctCaps('acct3', 40, false, 30)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.target.id).toBe('acct2'); // most 5h headroom — target selection stays 5h-based
    expect(d.reason).toMatch(/7d/);
  });

  it('watches on the WEEKLY (7d) band even though 5h is idle', () => {
    const d = decideRotation(caps([acctCaps('acct1', 20, false, 85)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('watch');
    expect(d.reason).toMatch(/7d/);
  });

  it('is idle when both 5h and 7d are well below soft', () => {
    const d = decideRotation(caps([acctCaps('acct1', 20, false, 20)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('idle');
  });

  it('rotates on 5h alone when 7d is null — a null 7d neither triggers nor blocks', () => {
    const d = decideRotation(
      caps([acctCaps('acct1', 95, false, null), acctCaps('acct2', 10, false, null)]),
      accounts, envOn(accounts[0]!),
    );
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.reason).not.toMatch(/7d/);
  });

  it('is unknown when both 5h and 7d are unavailable', () => {
    const d = decideRotation(caps([acctCaps('acct1', null, /*stale*/ true, null)]), accounts, envOn(accounts[0]!));
    expect(d.action).toBe('unknown');
  });

  it('honours custom 7d thresholds', () => {
    const strict7d = { ...DEFAULT_THRESHOLDS, soft7dPct: 50, hard7dPct: 60 };
    // 5h stays idle throughout (20%); only the 7d reading (55%) changes.
    expect(decideRotation(caps([acctCaps('acct1', 20, false, 55)]), accounts, envOn(accounts[0]!), strict7d).action).toBe('watch');
    expect(decideRotation(caps([acctCaps('acct1', 20, false, 55)]), accounts, envOn(accounts[0]!), DEFAULT_THRESHOLDS).action).toBe('idle');
  });
});

/**
 * readAndDecide reads the LIVE files. HED-165: it must read `readProviderCaps` (the SAME merged source
 * the dispatch router uses), NOT `readLimitsMirror` alone. The limits.json mirror carries a keeper-pinged
 * IDLE account as usedPercentage:null + stale:true, but `readClaudeTap`'s keeper anchor normalizes it to
 * 0% (fresh) and `readProviderCaps` merges that over the stale mirror row. Reading the mirror only made
 * the rotator blind to exactly the idle accounts it must rotate TO — it would declare `exhausted` with a
 * perfectly fresh account sitting right there, disagreeing with the dispatch router this module mirrors.
 * These tests write the real file shapes into a temp usageDir and prove the rotator now SEES them.
 */
describe('readAndDecide (file integration, HED-165)', () => {
  const { tempDir } = useTempResources('heddle-rotate-');
  const NOW_S = 1_800_000_000;
  const NOW_MS = NOW_S * 1000;

  // ~/.heddle/accounts.json shape: { claude: [{ id, configDir, loggedIn? }] }. configDir:null = default login.
  const writeAccounts = (dir: string, rows: Array<{ id: string; configDir: string | null; loggedIn?: boolean }>): string => {
    const p = join(dir, 'accounts.json');
    writeFileSync(p, JSON.stringify({ claude: rows }));
    return p;
  };

  // limits.json mirror (readLimitsMirror): a keeper-pinged idle account is usedPercentage:null + stale:true here.
  const writeLimits = (dir: string, accounts: Array<Record<string, unknown>>, activeAccount: string): void => {
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: NOW_S,
      limits: [{
        provider: 'claude', capturedAt: NOW_S, staleAfterSecs: 600, stale: false, activeAccount,
        fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
        accounts,
      }],
    }));
  };

  const mirrorRow = (id: string, usedPct: number | null, stale: boolean): Record<string, unknown> => ({
    id, stale,
    fiveHour: { usedPercentage: usedPct, resetsAt: NOW_S + 3600 },
    sevenDay: { usedPercentage: null, resetsAt: null },
  });

  // claude-<id>.keeper.json (readKeeperAnchor): a headless ping that STARTED a 5h window — used ≈ 0 while
  // resets_at is in the future. This is the row the mirror-only read could never see.
  const writeKeeper = (dir: string, id: string): void => {
    writeFileSync(join(dir, `claude-${id}.keeper.json`), JSON.stringify({
      account: id, startedAt: NOW_S - 60, resets_at: NOW_S + 3600, source: 'keeper-ping', used: null,
    }));
  };

  it('ROTATES to a keeper-anchored idle account the mirror alone would have hidden', () => {
    // acct2 active + over the hard cap; acct1 idle (null+stale in the mirror) with a LIVE keeper anchor.
    // Mirror-only → acct1 invisible → `exhausted`. readProviderCaps → acct1 normalized to 0% → `rotate`.
    const dir = tempDir();
    writeLimits(dir, [mirrorRow('acct2', 95, false), mirrorRow('acct1', null, true)], 'acct2');
    writeKeeper(dir, 'acct1');
    const accountsPath = writeAccounts(dir, [
      { id: 'acct2', configDir: null }, { id: 'acct1', configDir: '/h/.claude-acct1' },
    ]);

    const d = readAndDecide({ usageDir: dir, nowMs: NOW_MS, env: {}, accountsPath });
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.current).toBe('acct2');
    expect(d.target.id).toBe('acct1');
    expect(d.targetEnv.env).toEqual({ CLAUDE_CONFIG_DIR: '/h/.claude-acct1' });
  });

  it('is unknown (never crashes) when no usage files exist at all', () => {
    // readProviderCaps returns a claude entry with source:'none' (not undefined) — capsUsable treats it as
    // unknown, identical to the old missing-mirror path.
    const dir = tempDir();
    const accountsPath = writeAccounts(dir, [{ id: 'acct2', configDir: null }]);
    const d = readAndDecide({ usageDir: dir, nowMs: NOW_MS, env: {}, accountsPath });
    expect(d.action).toBe('unknown');
  });

  it('excludes a logged-out account even with a fresh keeper anchor, and picks a logged-in one', () => {
    // acct1 has a live keeper anchor (0%) but loggedIn:false → not addressable; acct3 (also keeper 0%,
    // logged in) is the correct target. Proves the loggedIn guard survives the keeper-anchor path.
    const dir = tempDir();
    writeLimits(dir, [mirrorRow('acct2', 95, false), mirrorRow('acct1', null, true), mirrorRow('acct3', null, true)], 'acct2');
    writeKeeper(dir, 'acct1');
    writeKeeper(dir, 'acct3');
    const accountsPath = writeAccounts(dir, [
      { id: 'acct2', configDir: null },
      { id: 'acct1', configDir: '/h/.claude-acct1', loggedIn: false },
      { id: 'acct3', configDir: '/h/.claude-acct3' },
    ]);

    const d = readAndDecide({ usageDir: dir, nowMs: NOW_MS, env: {}, accountsPath });
    expect(d.action).toBe('rotate');
    if (d.action !== 'rotate') throw new Error('unreachable');
    expect(d.target.id).toBe('acct3'); // acct1 excluded despite its fresh keeper anchor
  });
});
