import { describe, expect, it } from 'vitest';
import type { ClaudeAccount } from '../src/capaware.js';
import { pickClaudeAccountToSwitch, SWITCH_RESET_SOON_S, type ResidentLoad } from '../src/account-pick.js';
import type { ClaudeFloors } from '../src/floors.js';
import type { ProviderCaps } from '../src/usage.js';

const NOW = 1_800_000_000;
const floors: ClaudeFloors = { neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 };

// The live registry's shape: acct2 and acct4 are two folders logged into ONE login.
const registry: ClaudeAccount[] = [
  { id: 'acct1', configDir: '/x/.claude-acct1', accountUuid: 'LOGIN-1' },
  { id: 'acct2', configDir: '/x/.claude-acct2', accountUuid: 'LOGIN-2' },
  { id: 'acct3', configDir: '/x/.claude-acct3', accountUuid: 'LOGIN-3' },
  { id: 'acct4', configDir: '/x/.claude-acct4', accountUuid: 'LOGIN-2' },
];
const loginOf = (account: ClaudeAccount) => `uuid:${account.accountUuid}`;

interface Reading {
  used5h: number | null;
  used7d?: number | null;
  reset5h?: number | null;
  /** A dispatch failure signalled for the account just now. */
  failed?: 'billing' | 'logged-out';
}
function caps(readings: Record<string, Reading>): ProviderCaps {
  return {
    provider: 'claude', source: 'limits.json', stale: false, capturedAt: NOW,
    fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
    windows: {}, noteCodes: [], activeAccount: null,
    accounts: Object.entries(readings).map(([id, { used5h, used7d = null, reset5h = null, failed }]) => ({
      id, fiveHour: { usedPercentage: used5h, resetsAt: reset5h }, sevenDay: { usedPercentage: used7d, resetsAt: null },
      windows: {}, noteCodes: [], limitReached: false, stale: false,
      // Dispatch signals are judged against the real clock (isDispatchExcluded).
      ...(failed ? { dispatch: { account: id, dispatchable: false, reason: failed, checkedAt: Math.floor(Date.now() / 1000) - 10 } } : {}),
    })),
  };
}

function pick(
  readings: Record<string, Reading>, leaving: string,
  residents: ReadonlyMap<string, ResidentLoad> | null = new Map(), accounts: ClaudeAccount[] = registry,
) {
  return pickClaudeAccountToSwitch(caps(readings), accounts, floors, { leaving, loginOf, residents, nowS: NOW });
}

describe('pickClaudeAccountToSwitch', () => {
  it('never picks the login being left, whichever of its folders the session ran in', () => {
    const result = pick({ acct1: { used5h: 10 }, acct2: { used5h: 5 }, acct3: { used5h: 50 }, acct4: { used5h: 5 } }, 'uuid:LOGIN-2');
    expect(result.pick).toMatchObject({ account: 'acct1', roomPct: 90 });
  });

  it('counts folders sharing a login as one candidate, at the least room any of them reads', () => {
    // Per account, acct2 (80% room) would win; as one login with acct4 (40%), it has 40% — less than acct3.
    const result = pick({ acct2: { used5h: 20 }, acct3: { used5h: 50 }, acct4: { used5h: 60 } }, 'uuid:LOGIN-1');
    expect(result.pick).toMatchObject({ account: 'acct3', roomPct: 50 });
    expect(result.pick?.reason).toContain('best of 2 login(s)');
  });

  it('moves onto a login through its first folder in registry order', () => {
    const result = pick({ acct2: { used5h: 30 }, acct3: { used5h: 50 }, acct4: { used5h: 20 } }, 'uuid:LOGIN-1');
    expect(result.pick).toMatchObject({ account: 'acct2', configDir: '/x/.claude-acct2', unsetConfigDir: false, roomPct: 70 });
  });

  it('regression — reports the highest usage any of the login\'s folders reads, not the usage of the folder it moves into', () => {
    // The caller refuses a pick at 85% 5h by these meters; acct2's own 10% would hide acct4's 60%.
    const result = pick({ acct2: { used5h: 10, used7d: 20 }, acct3: { used5h: 70 }, acct4: { used5h: 60, used7d: 20 } }, 'uuid:LOGIN-1');
    expect(result.pick).toMatchObject({ account: 'acct2', configDir: '/x/.claude-acct2', roomPct: 40, usedPct5h: 60, usedPct7d: 20 });
  });

  it('regression — reports the same peak usage whatever order the login\'s folders are in, even when their room ties', () => {
    // Both folders read 14% room, one on its 7d window and one on its 5h; neither alone shows both peaks.
    const readings = { acct2: { used5h: 10, used7d: 86 }, acct3: { used5h: 90 }, acct4: { used5h: 86, used7d: 10 } };
    const reversed = [registry[0], registry[3], registry[2], registry[1]];
    for (const accounts of [registry, reversed]) {
      expect(pick(readings, 'uuid:LOGIN-1', new Map(), accounts).pick)
        .toMatchObject({ roomPct: 14, usedPct5h: 86, usedPct7d: 86, bindingMeter: '5h' });
    }
  });

  it('never picks an account whose login can\'t be told, since it may be the login being left', () => {
    const unknown = (account: ClaudeAccount) => (account.id === 'acct1' ? null : `uuid:${account.accountUuid}`);
    const result = pickClaudeAccountToSwitch(caps({ acct1: { used5h: 0 }, acct2: { used5h: 50 }, acct3: { used5h: 60 }, acct4: { used5h: 50 } }),
      registry, floors, { leaving: 'uuid:LOGIN-2', loginOf: unknown, residents: new Map(), nowS: NOW });
    expect(result.pick).toMatchObject({ account: 'acct3' });
    expect(result.rows.map((row) => [row.account, row.leaving])).toEqual([['acct1', null], ['acct2', true], ['acct3', false], ['acct4', true]]);
    const none = pickClaudeAccountToSwitch(caps({ acct1: { used5h: 0 }, acct3: { used5h: 99 } }),
      registry, floors, { leaving: 'uuid:LOGIN-2', loginOf: unknown, residents: new Map(), nowS: NOW });
    expect(none).toMatchObject({ pick: null, reason: expect.stringContaining(', 1 whose login can\'t be told') });
  });

  it('regression — takes the whole login out when any of its folders is floored, overage or failed on billing', () => {
    // acct2 alone reads 90% room, but acct4 shares its pool and reads it nearly exhausted.
    expect(pick({ acct2: { used5h: 10 }, acct3: { used5h: 70 }, acct4: { used5h: 98 } }, 'uuid:LOGIN-1').pick)
      .toMatchObject({ account: 'acct3', roomPct: 30 });
    // Out, not merely ranked low: with every other login out too, nothing is picked.
    expect(pick({ acct2: { used5h: 10 }, acct3: { used5h: 99 }, acct4: { used5h: 98 } }, 'uuid:LOGIN-1').pick).toBeNull();
    const overage = registry.map((account) => (account.id === 'acct4' ? { ...account, overageEnabled: true } : account));
    expect(pick({ acct2: { used5h: 10 }, acct3: { used5h: 70 }, acct4: { used5h: 10 } }, 'uuid:LOGIN-1', new Map(), overage).pick)
      .toMatchObject({ account: 'acct3' });
    expect(pick({ acct2: { used5h: 10 }, acct3: { used5h: 70 }, acct4: { used5h: 10, failed: 'billing' } }, 'uuid:LOGIN-1').pick)
      .toMatchObject({ account: 'acct3' });
  });

  it('moves past a folder that is logged out, but still counts its reading toward the login\'s room', () => {
    const loggedOut = registry.map((account) => (account.id === 'acct2' ? { ...account, loggedIn: false as const } : account));
    const result = pick({ acct2: { used5h: 40 }, acct3: { used5h: 80 }, acct4: { used5h: 20 } }, 'uuid:LOGIN-1', new Map(), loggedOut);
    expect(result.pick).toMatchObject({ account: 'acct4', configDir: '/x/.claude-acct4', roomPct: 60, usedPct5h: 40 });
    // A dispatch signal that the folder lost its login rules out that folder alone, too.
    expect(pick({ acct2: { used5h: 20, failed: 'logged-out' }, acct3: { used5h: 80 }, acct4: { used5h: 20 } }, 'uuid:LOGIN-1').pick)
      .toMatchObject({ account: 'acct4', roomPct: 80 });
  });

  it('moves into a folder with no reading of its own when another folder of its login has one', () => {
    expect(pick({ acct2: { used5h: null }, acct3: { used5h: 80 }, acct4: { used5h: 30 } }, 'uuid:LOGIN-1').pick)
      .toMatchObject({ account: 'acct2', roomPct: 70, usedPct5h: 30 });
  });

  it('shares a login\'s room with the sessions already on it', () => {
    const readings = { acct2: { used5h: 20 }, acct3: { used5h: 50 }, acct4: { used5h: 20 } };
    expect(pick(readings, 'uuid:LOGIN-1').pick).toMatchObject({ account: 'acct2', residents: 0 });
    // One session on LOGIN-2: 80 ÷ 2 = 40 per seat, less than LOGIN-3's 50.
    const busy = new Map([['uuid:LOGIN-2', { count: 1, weight: 1 }]]);
    expect(pick(readings, 'uuid:LOGIN-1', busy).pick).toMatchObject({ account: 'acct3', residents: 0 });
    // A heavier seat weighs more: 80 ÷ 3.5 against 50.
    const heavy = new Map([['uuid:LOGIN-2', { count: 1, weight: 2.5 }], ['uuid:LOGIN-3', { count: 1, weight: 1 }]]);
    expect(pick(readings, 'uuid:LOGIN-1', heavy).pick).toMatchObject({ account: 'acct3', residents: 1 });
  });

  it('ranks on room alone, and says so, when the session census is unavailable', () => {
    const result = pick({ acct2: { used5h: 20 }, acct3: { used5h: 50 }, acct4: { used5h: 20 } }, 'uuid:LOGIN-1', null);
    expect(result.pick).toMatchObject({ account: 'acct2', residents: null });
    expect(result.pick?.reason).toContain('sessions there unknown');
  });

  it('counts a 5h window that resets within 30 minutes as empty while more than 15% is left on it', () => {
    const soon = NOW + 10 * 60;
    const result = pick({
      acct2: { used5h: 80, reset5h: soon }, acct3: { used5h: 40 }, acct4: { used5h: 80, reset5h: soon },
    }, 'uuid:LOGIN-1');
    expect(result.pick).toMatchObject({ account: 'acct2', roomPct: 100, usedPct5h: 80 });
    expect(result.pick?.reason).toContain('resetting within 30 min');
  });

  it('gives no reset credit to a window resetting later, to one with 15% or less left, or to one already reset', () => {
    const later = { acct2: { used5h: 80, reset5h: NOW + SWITCH_RESET_SOON_S + 60 }, acct3: { used5h: 40 }, acct4: { used5h: 80 } };
    expect(pick(later, 'uuid:LOGIN-1').pick).toMatchObject({ account: 'acct3', roomPct: 60 });
    const nearlyFull = { acct2: { used5h: 85, reset5h: NOW + 60 }, acct3: { used5h: 40 }, acct4: { used5h: 85, reset5h: NOW + 60 } };
    expect(pick(nearlyFull, 'uuid:LOGIN-1').pick).toMatchObject({ account: 'acct3', roomPct: 60 });
    const past = { acct2: { used5h: 80, reset5h: NOW - 60 }, acct3: { used5h: 40 }, acct4: { used5h: 80, reset5h: NOW - 60 } };
    expect(pick(past, 'uuid:LOGIN-1').pick).toMatchObject({ account: 'acct3', roomPct: 60 });
  });

  it('measures room on the tighter window, and a 5h reset never lifts a full week', () => {
    expect(pick({ acct2: { used5h: 10, used7d: 85 }, acct3: { used5h: 50, used7d: 20 }, acct4: { used5h: 10, used7d: 85 } }, 'uuid:LOGIN-1').pick)
      .toMatchObject({ account: 'acct3', roomPct: 50 });
    const soon = NOW + 10 * 60;
    expect(pick({
      acct2: { used5h: 80, used7d: 70, reset5h: soon }, acct3: { used5h: 50, used7d: 20 }, acct4: { used5h: 80, used7d: 70, reset5h: soon },
    }, 'uuid:LOGIN-1').pick).toMatchObject({ account: 'acct3', roomPct: 50 });
  });

  it('never picks a floored, logged-out or unmetered account, even one resetting soon', () => {
    const accounts: ClaudeAccount[] = [
      ...registry,
      { id: 'acct5', configDir: '/x/.claude-acct5', accountUuid: 'LOGIN-5', loggedIn: false },
      { id: 'acct6', configDir: '/x/.claude-acct6', accountUuid: 'LOGIN-6' },
    ];
    const result = pick({
      acct1: { used5h: 98, reset5h: NOW + 60 }, acct3: { used5h: 70 }, acct5: { used5h: 0 }, acct6: { used5h: null },
    }, 'uuid:LOGIN-2', new Map(), accounts);
    expect(result.pick).toMatchObject({ account: 'acct3', roomPct: 30 });
  });

  it('refuses, saying why, when no other login has a usable account', () => {
    const result = pick({ acct1: { used5h: 99 }, acct2: { used5h: 10 }, acct3: { used5h: null }, acct4: { used5h: 10 } }, 'uuid:LOGIN-2');
    expect(result.pick).toBeNull();
    expect(result).toMatchObject({
      reason: expect.stringMatching(/no other login has a usable account: 2 account\(s\) on the login being left, 2 on logins ruled out/),
    });
    expect(result.rows.map((row) => [row.account, row.leaving])).toEqual([['acct1', false], ['acct2', true], ['acct3', false], ['acct4', true]]);
  });

  it('breaks an exact tie by account id', () => {
    const result = pick({ acct1: { used5h: 50 }, acct2: { used5h: 50 }, acct3: { used5h: 50 }, acct4: { used5h: 50 } }, 'uuid:LOGIN-1');
    expect(result.pick?.account).toBe('acct2');
  });
});
