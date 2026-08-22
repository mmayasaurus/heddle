import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeFloorsFrom, headroomPct, isFloored, type ClaudeFloors } from '../src/floors.js';
import { loadLanes } from '../src/lanes.js';
import { pickClaudeAccount, type ClaudeAccount } from '../src/capaware.js';
import type { ProviderCaps } from '../src/usage.js';

const floors: ClaudeFloors = { neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 };

const claudeCaps = (rows: Array<{ id: string; used: number | null }>): ProviderCaps => ({
  provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1,
  fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
  windows: {}, noteCodes: [], activeAccount: null,
  accounts: rows.map(({ id, used }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false })),
});
const accts: ClaudeAccount[] = [{ id: 'a', configDir: null }, { id: 'b', configDir: '/x/.claude-b' }];

describe('claude floors (HED-261)', () => {
  it('reads the floors from the ratified lanes.yaml', () => {
    const lanes = loadLanes(join(process.cwd(), 'routing/lanes.yaml'));
    expect(claudeFloorsFrom(lanes)).toEqual({ neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 });
  });

  it('headroom is 100 − used; unknown stays unknown', () => {
    expect(headroomPct(90)).toBe(10);
    expect(headroomPct(0)).toBe(100);
    expect(headroomPct(null)).toBeNull();
  });

  it('floors an account at or below the headroom floor (INCLUSIVE) — the rollover-scare guard', () => {
    expect(isFloored(98, floors)).toBe(true);   // headroom 2 → floored (the 98% resume the rollover hit)
    expect(isFloored(100, floors)).toBe(true);  // headroom 0 → floored (the 100% resume)
    // boundary: ratified lanes.yaml is "never rotate INTO ≤3%" → INCLUSIVE, so headroom == the floor is floored (R nod 2026-08-22).
    expect(isFloored(97, floors)).toBe(true);   // headroom 3 ≤ 3 → floored
    expect(isFloored(96, floors)).toBe(false);  // headroom 4 > 3 → allowed
    expect(isFloored(50, floors)).toBe(false);
    expect(isFloored(null, floors)).toBe(false); // unknown never decides
  });
});

describe('pickClaudeAccount floor integration (HED-261)', () => {
  it('excludes a floored account and picks the healthy one', () => {
    // a at 98% (headroom 2 < 3 → floored), b at 40% (healthy) → picks b despite a's lower id order.
    const pick = pickClaudeAccount(claudeCaps([{ id: 'a', used: 98 }, { id: 'b', used: 40 }]), accts, { floors });
    expect(pick?.account.id).toBe('b');
  });

  it('returns null when EVERY account is floored — the walk then expands off claude (HED-264)', () => {
    const pick = pickClaudeAccount(claudeCaps([{ id: 'a', used: 99 }, { id: 'b', used: 98 }]), accts, { floors });
    expect(pick).toBeNull();
  });

  it('without floors (byte-stable) a near-exhausted account is still picked', () => {
    const pick = pickClaudeAccount(claudeCaps([{ id: 'a', used: 98 }, { id: 'b', used: 99 }]), accts, {});
    expect(pick?.account.id).toBe('a'); // 98 < 99 → most 5h headroom, floor not applied
  });
});
