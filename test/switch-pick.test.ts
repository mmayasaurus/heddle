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

interface Reading { used5h: number | null; used7d?: number | null; reset5h?: number | null }
function caps(readings: Record<string, Reading>): ProviderCaps {
  return {
    provider: 'claude', source: 'limits.json', stale: false, capturedAt: NOW,
    fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
    windows: {}, noteCodes: [], activeAccount: null,
    accounts: Object.entries(readings).map(([id, { used5h, used7d = null, reset5h = null }]) => ({
      id, fiveHour: { usedPercentage: used5h, resetsAt: reset5h }, sevenDay: { usedPercentage: used7d, resetsAt: null },
      windows: {}, noteCodes: [], limitReached: false, stale: false,
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
      reason: expect.stringMatching(/no other login has a usable account: 2 account\(s\) on the login being left, 2 excluded/),
    });
    expect(result.rows.map((row) => [row.account, row.leaving])).toEqual([['acct1', false], ['acct2', true], ['acct3', false], ['acct4', true]]);
  });

  it('breaks an exact tie by account id', () => {
    const result = pick({ acct1: { used5h: 50 }, acct2: { used5h: 50 }, acct3: { used5h: 50 }, acct4: { used5h: 50 } }, 'uuid:LOGIN-1');
    expect(result.pick?.account).toBe('acct2');
  });
});
