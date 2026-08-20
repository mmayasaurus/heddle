import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adviseClaudeAccount, bestFableWeekly, pickClaudeAccount, type ClaudeAccount } from '../src/capaware.js';
import { readClaudeTap, readProviderCaps, type ProviderCaps } from '../src/usage.js';
import { useTempResources } from './helpers.js';

const registry: ClaudeAccount[] = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.claude-acct2' }, { id: 'acct3', configDir: '/x/.claude-acct3' }];
const claudeCaps = (rows: Array<{ id: string; used: number | null; stale?: boolean }>): ProviderCaps => ({ provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], activeAccount: null, accounts: rows.map(({ id, used, stale = false }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale })) });

describe('pickClaudeAccount', () => {
  it('chooses the freshest registered account with the most five-hour headroom', () => {
    const pick = pickClaudeAccount(claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: 1 }, { id: 'acct3', used: 1, stale: true }]), registry)!;
    expect(pick).toMatchObject({ account: { id: 'acct2' }, usedPct: 1, env: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' }, envUnset: [] });
    expect(pick.reason).toContain('account:acct2 (5h 1%, most headroom of 2 fresh)');
  });

  it('unsets the inherited config directory when the default login has the only fresh capture', () => {
    const pick = pickClaudeAccount(claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: null, stale: true }, { id: 'acct3', used: null, stale: true }]), registry)!;
    expect(pick).toMatchObject({ account: { id: 'acct1' }, env: {}, envUnset: ['CLAUDE_CONFIG_DIR'] });
    expect(pick.reason).toContain('most headroom of 1 fresh');
  });

  it('falls back to the default account without fresh captures or the first account when none is default', () => {
    expect(pickClaudeAccount(claudeCaps(registry.map((a) => ({ id: a.id, used: null, stale: true }))), registry)).toMatchObject({ account: { id: 'acct1' }, reason: expect.stringContaining('default (no fresh per-account caps)'), envUnset: ['CLAUDE_CONFIG_DIR'] });
    expect(pickClaudeAccount(undefined, registry.slice(1))).toMatchObject({ account: { id: 'acct2' }, env: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' } });
  });

  it('honors a registered pin even when stale and rejects an unknown account pin with known ids', () => {
    expect(pickClaudeAccount(claudeCaps([{ id: 'acct3', used: 1, stale: true }]), registry, { pin: 'acct3' })).toMatchObject({ account: { id: 'acct3' }, usedPct: null, reason: 'account:acct3 pinned', env: { CLAUDE_CONFIG_DIR: '/x/.claude-acct3' } });
    expect(() => pickClaudeAccount(undefined, registry, { pin: 'nope' })).toThrow(/account_pin "nope".*acct1.*acct2.*acct3/);
    expect(pickClaudeAccount(undefined, registry, { pin: 'acct1' })?.envUnset).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('still selects the least-used fresh account when every account is at or over the route-away threshold', () => {
    const pick = pickClaudeAccount(claudeCaps([{ id: 'acct1', used: 95 }, { id: 'acct2', used: 97 }]), registry, { routeAwayAtPct: 90 })!;
    expect(pick.account.id).toBe('acct1');
    expect(pick.reason).toContain('every fresh account is at/over 90%');
  });

  it('returns null for an empty registry and preserves registry order for equal fresh usage', () => {
    expect(pickClaudeAccount(undefined, [])).toBeNull();
    expect(pickClaudeAccount(claudeCaps([{ id: 'acct1', used: 20 }, { id: 'acct2', used: 20 }]), registry)?.account.id).toBe('acct1');
  });
});

/**
 * HED-190 review: `prefer7d` is what the rotator passes when the WEEKLY cap is the reason it is
 * rotating. Ranking by 5h headroom there can hand the fleet an account that is idle this hour and
 * out of weekly allowance, so the relaunched fleet hits the weekly wall immediately.
 */
describe('pickClaudeAccount — weekly (7d) headroom ranking', () => {
  const caps7d = (rows: Array<{ id: string; used: number | null; used7d?: number | null; stale?: boolean }>): ProviderCaps => ({
    provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1,
    fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
    windows: {}, noteCodes: [], activeAccount: null,
    accounts: rows.map(({ id, used, used7d = null, stale = false }) => ({
      id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: used7d, resetsAt: null },
      windows: {}, noteCodes: [], limitReached: false, stale,
    })),
  });
  const weekly = { prefer7d: true, routeAwayAtPct: 90, routeAwayAt7dPct: 90 };

  it('ranks by weekly headroom, not 5h, and reports both windows', () => {
    const pick = pickClaudeAccount(
      caps7d([{ id: 'acct1', used: 10, used7d: 95 }, { id: 'acct2', used: 40, used7d: 30 }]), registry, weekly,
    )!;
    expect(pick).toMatchObject({ account: { id: 'acct2' }, usedPct: 40, usedPct7d: 30 });
    expect(pick.reason).toContain('account:acct2 weekly-headroom (7d 30%, 5h 40%');
  });

  it('reports the weekly reading on the ordinary 5h path too', () => {
    // The rotator's weekly EXHAUSTED guard reads `usedPct7d` off the pick, so every path must carry it.
    const pick = pickClaudeAccount(caps7d([{ id: 'acct1', used: 10, used7d: 44 }]), registry)!;
    expect(pick).toMatchObject({ account: { id: 'acct1' }, usedPct: 10, usedPct7d: 44 });
  });

  it('prefers a KNOWN low 7d over an unknown one, but still picks an unknown 7d over nothing', () => {
    // A keeper-anchored idle account has no 7d reading at all (usage.ts readClaudeTap), so an unknown
    // 7d must never be ranked last — it would leave a weekly-triggered rotation with no target.
    expect(pickClaudeAccount(
      caps7d([{ id: 'acct1', used: 0, used7d: null }, { id: 'acct2', used: 40, used7d: 20 }]), registry, weekly,
    )!.account.id).toBe('acct2');
    const only = pickClaudeAccount(caps7d([{ id: 'acct2', used: 0, used7d: null }]), registry, weekly)!;
    expect(only).toMatchObject({ account: { id: 'acct2' }, usedPct7d: null });
    expect(only.reason).toContain('7d unknown');
  });

  it('sorts an account that is dead in EITHER window last, and says so', () => {
    // acct1 is weekly-dead, acct2 is 5h-dead; acct3 is usable in both and must win.
    expect(pickClaudeAccount(
      caps7d([{ id: 'acct1', used: 1, used7d: 92 }, { id: 'acct2', used: 95, used7d: 1 }, { id: 'acct3', used: 50, used7d: 60 }]),
      registry, weekly,
    )!.account.id).toBe('acct3');
    // Everything weekly-dead → the least-dead is still RETURNED (never null), flagged, so the caller
    // can declare `exhausted` instead of silently rotating into the wall.
    const pick = pickClaudeAccount(
      caps7d([{ id: 'acct1', used: 1, used7d: 95 }, { id: 'acct2', used: 2, used7d: 91 }]), registry, weekly,
    )!;
    expect(pick).toMatchObject({ account: { id: 'acct2' }, usedPct7d: 91 });
    expect(pick.reason).toContain('every fresh account is at/over a hard cap');
  });

  it('falls back to the no-fresh-caps path when nothing is rankable', () => {
    const pick = pickClaudeAccount(caps7d([{ id: 'acct1', used: null, used7d: 20, stale: true }]), registry, weekly)!;
    expect(pick.reason).toContain('default (no fresh per-account caps)');
  });
});

describe('pickClaudeAccount — logged-out accounts are not addressable', () => {
  const registry = [
    { id: 'acct1', configDir: '/x/.claude-acct1', loggedIn: false },
    { id: 'acct2', configDir: null },
    { id: 'acct3', configDir: '/x/.claude-acct3' },
  ];
  function capsWith(rows: { id: string; used: number | null; stale?: boolean }[]) {
    return {
      provider: 'claude', source: 'claude-tap' as const, stale: false, capturedAt: 1, fiveHour: { usedPercentage: null, resetsAt: null },
      sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], activeAccount: null,
      accounts: rows.map((r) => ({ id: r.id, fiveHour: { usedPercentage: r.used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: r.stale ?? false })),
    };
  }

  it('never selects a logged-out account even when it has the freshest, lowest capture (a keeper anchor for a replaced credential)', async () => {
    const { pickClaudeAccount } = await import('../src/capaware.js');
    const pick = pickClaudeAccount(capsWith([{ id: 'acct1', used: 0 }, { id: 'acct2', used: 68 }]), registry)!;
    expect(pick.account.id).toBe('acct2');
    expect(pick.envUnset).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('refuses a pin to a logged-out account with the exact re-login command', async () => {
    const { pickClaudeAccount } = await import('../src/capaware.js');
    expect(() => pickClaudeAccount(capsWith([]), registry, { pin: 'acct1' }))
      .toThrow(/NOT logged in.*CLAUDE_CONFIG_DIR=\/x\/\.claude-acct1 claude \/login/s);
  });

  it('falls back to the default among ADDRESSABLE accounts when nothing is fresh', async () => {
    const { pickClaudeAccount } = await import('../src/capaware.js');
    const pick = pickClaudeAccount(capsWith([]), registry)!;
    expect(pick.account.id).toBe('acct2');
    // and when the registry has no addressable default, the first addressable account wins
    // and when EVERY registered account is logged out, the picker returns null (no pick) — the
    // worker inherits the caller's own login instead of a credential known to 401
    const allOut = [{ id: 'a', configDir: '/x/.a', loggedIn: false }, { id: 'b', configDir: null, loggedIn: false }];
    expect(pickClaudeAccount(undefined, allOut)).toBeNull();
    const noDefault = [{ id: 'acct1', configDir: '/x/.a1', loggedIn: false }, { id: 'acct3', configDir: '/x/.a3' }];
    expect(pickClaudeAccount(capsWith([]), noDefault)!.account.id).toBe('acct3');
  });

  it('advice excludes logged-out accounts from the headroom ranking', async () => {
    const { adviseClaudeAccount } = await import('../src/capaware.js');
    const advice = adviseClaudeAccount(capsWith([{ id: 'acct1', used: 0 }, { id: 'acct2', used: 40 }, { id: 'acct3', used: 20 }]), registry);
    expect(advice.best?.id).toBe('acct3');
    expect(advice.line).toContain('acct3 has the most 5h headroom');
  });
});

describe('regression PR#176 — picker skips non-dispatchable accounts', () => {
  const { tempDir } = useTempResources('heddle-dispatch-signal-');
  const nowS = Math.floor(Date.now() / 1000);
  const accounts: ClaudeAccount[] = [
    { id: 'acct1', configDir: null },
    { id: 'acct2', configDir: '/x/.claude-acct2' },
  ];
  type Reason = 'ok' | 'billing' | 'logged-out' | 'rate-capped' | 'error';
  const capsFromSignals = (signals: Array<{ account: string; reason: Reason; checkedAt?: number }> = []) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS,
      limits: [{ provider: 'claude', capturedAt: nowS, staleAfterSecs: 900, accounts: [
        { id: 'acct1', fiveHour: { usedPercentage: 75 }, sevenDay: {} },
        { id: 'acct2', fiveHour: { usedPercentage: 1 }, sevenDay: {} },
      ] }],
    }));
    for (const signal of signals) {
      writeFileSync(join(dir, `claude-${signal.account}.dispatch.json`), JSON.stringify({
        schemaVersion: 1, account: signal.account, dispatchable: signal.reason === 'ok', reason: signal.reason,
        checkedAt: signal.checkedAt ?? nowS,
      }));
    }
    return readProviderCaps({ usageDir: dir, nowS }).claude;
  };

  it('excludes fresh logged-out and billing accounts even when they have the most headroom', () => {
    for (const reason of ['logged-out', 'billing'] as const) {
      const pick = pickClaudeAccount(capsFromSignals([{ account: 'acct2', reason }]), accounts)!;
      expect(pick.account.id).toBe('acct1');
    }
  });

  it('fails open for fresh ok, error, and rate-capped signals', () => {
    for (const reason of ['ok', 'error', 'rate-capped'] as const) {
      const pick = pickClaudeAccount(capsFromSignals([{ account: 'acct2', reason }]), accounts)!;
      expect(pick.account.id).toBe('acct2');
    }
  });

  it('fails open for a stale logged-out signal and for absent signal files', () => {
    expect(pickClaudeAccount(capsFromSignals([{ account: 'acct2', reason: 'logged-out', checkedAt: nowS - 21_601 }]), accounts)!.account.id).toBe('acct2');
    expect(pickClaudeAccount(capsFromSignals(), accounts)!.account.id).toBe('acct2');
  });

  it('refuses a pin to a fresh non-dispatchable account', () => {
    expect(() => pickClaudeAccount(capsFromSignals([{ account: 'acct2', reason: 'billing' }]), accounts, { pin: 'acct2' }))
      .toThrow(/account_pin "acct2".*NOT dispatchable.*billing/s);
  });
});

describe('regression PR#176 — dispatch signals cover signal-only and all account selection paths', () => {
  const { tempDir } = useTempResources('heddle-dispatch-signal-review-');
  const nowS = Math.floor(Date.now() / 1000);
  const accounts: ClaudeAccount[] = [
    { id: 'acct1', configDir: null },
    { id: 'acct2', configDir: '/x/.claude-acct2' },
  ];
  const signal = (dir: string, account: string, reason: 'ok' | 'billing' | 'logged-out' | 'rate-capped' | 'error', checkedAt = nowS, extra: Record<string, unknown> = {}) => {
    writeFileSync(join(dir, `claude-${account}.dispatch.json`), JSON.stringify({
      schemaVersion: 1, account, dispatchable: reason === 'ok', reason, checkedAt, ...extra,
    }));
  };
  const freshMirror = (dir: string) => writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{ provider: 'claude', capturedAt: nowS, staleAfterSecs: 900, accounts: [
      { id: 'acct1', fiveHour: { usedPercentage: 70 }, sevenDay: {}, fableWeeklyEstimatePct: 40, fableWeeklySamples: 7 },
      { id: 'acct2', fiveHour: { usedPercentage: 1 }, sevenDay: {}, fableWeeklyEstimatePct: 10, fableWeeklySamples: 7 },
    ] }],
  }));

  it('adds a signal-only billing account as a stale dispatch row and never picks it', () => {
    const dir = tempDir();
    signal(dir, 'acct2', 'billing');
    const caps = readProviderCaps({ usageDir: dir, nowS }).claude;
    expect(caps.accounts).toContainEqual(expect.objectContaining({ id: 'acct2', stale: true, noteCodes: ['claude.dispatchSignalOnly'], dispatch: expect.objectContaining({ reason: 'billing' }) }));
    expect(pickClaudeAccount(caps, accounts)?.account.id).toBe('acct1');
  });

  it('does not treat a dispatch sidecar as a Claude tap account', () => {
    const dir = tempDir();
    signal(dir, 'acct2', 'billing');
    expect(readClaudeTap(dir, nowS)).toBeNull();
  });

  it('excludes a fresh billing account from Fable weekly ranking and advice', () => {
    const dir = tempDir(); freshMirror(dir); signal(dir, 'acct2', 'billing');
    const caps = readProviderCaps({ usageDir: dir, nowS }).claude;
    expect(bestFableWeekly(caps, accounts)).toEqual({ id: 'acct1', pct: 40 });
    expect(adviseClaudeAccount(caps, accounts, {}).best?.id).toBe('acct1');
  });

  it('returns null when every registered account is freshly excluded', () => {
    const dir = tempDir(); signal(dir, 'acct1', 'billing'); signal(dir, 'acct2', 'logged-out');
    expect(pickClaudeAccount(readProviderCaps({ usageDir: dir, nowS }).claude, accounts)).toBeNull();
  });

  it('ignores a signal-only row for an unregistered account without crashing', () => {
    const dir = tempDir(); signal(dir, 'unregistered', 'billing');
    expect(pickClaudeAccount(readProviderCaps({ usageDir: dir, nowS }).claude, accounts)?.account.id).toBe('acct1');
  });

  it('fails open for a billing signal checked in the future', () => {
    const dir = tempDir(); freshMirror(dir); signal(dir, 'acct2', 'billing', nowS + 1);
    expect(pickClaudeAccount(readProviderCaps({ usageDir: dir, nowS }).claude, accounts)?.account.id).toBe('acct2');
  });

  it('fails open for each invalid dispatch signal contract', () => {
    const invalid = [
      { schemaVersion: 2 },
      { account: 'acct1' },
      { dispatchable: true },
    ];
    for (const extra of invalid) {
      const dir = tempDir(); freshMirror(dir); signal(dir, 'acct2', 'billing', nowS, extra);
      expect(pickClaudeAccount(readProviderCaps({ usageDir: dir, nowS }).claude, accounts)?.account.id).toBe('acct2');
    }
  });

  it('allows pinning a healthy account while another account is freshly excluded', () => {
    const dir = tempDir(); freshMirror(dir); signal(dir, 'acct2', 'billing');
    expect(pickClaudeAccount(readProviderCaps({ usageDir: dir, nowS }).claude, accounts, { pin: 'acct1' })?.account.id).toBe('acct1');
  });
});
