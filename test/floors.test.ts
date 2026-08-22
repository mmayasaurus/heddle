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

describe('pickClaudeAccount floor integration (HED-261, opt-in only)', () => {
  // Each test contrasts WITH vs WITHOUT floors so the floor is load-bearing — the assertion would fail
  // if isFloored were a no-op. (A floored account has HIGH used%, so it is never the "most headroom"
  // pick anyway; the floor only changes the outcome when it removes an otherwise-selected account.)
  it('floors the only addressable account (near-exhausted) → null, where no-floors picks it', () => {
    const caps = claudeCaps([{ id: 'a', used: 98 }]);
    const one: ClaudeAccount[] = [{ id: 'a', configDir: null }];
    expect(pickClaudeAccount(caps, one, {})?.account.id).toBe('a'); // no floors → picked (byte-stable)
    expect(pickClaudeAccount(caps, one, { floors })).toBeNull();     // floors → excluded → null
  });

  it('returns null when every account is floored (the CLI relaunch pick refuses; router enrichment is HED-340)', () => {
    const caps = claudeCaps([{ id: 'a', used: 99 }, { id: 'b', used: 98 }]);
    expect(pickClaudeAccount(caps, accts, {})?.account.id).toBe('b'); // no floors → picks the least-floored
    expect(pickClaudeAccount(caps, accts, { floors })).toBeNull();    // floors → null
  });

  it('excludes a floored account and picks a healthy sibling', () => {
    expect(pickClaudeAccount(claudeCaps([{ id: 'a', used: 98 }, { id: 'b', used: 40 }]), accts, { floors })?.account.id).toBe('b');
  });

  it('unknown/stale used is NOT floored — the picker still selects (unknown never decides)', () => {
    expect(pickClaudeAccount(claudeCaps([{ id: 'a', used: null }, { id: 'b', used: null }]), accts, { floors })).not.toBeNull();
  });
});
