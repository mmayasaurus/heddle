import { describe, expect, it } from 'vitest';
import { pickClaudeAccount, type ClaudeAccount } from '../src/capaware.js';
import type { ProviderCaps } from '../src/usage.js';

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
