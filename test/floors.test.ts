import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingMeter, claudeFloorsFrom, headroomPct, isFloored, type ClaudeFloors } from '../src/floors.js';
import { loadLanes } from '../src/lanes.js';
import { pickClaudeAccount, type ClaudeAccount } from '../src/capaware.js';
import type { ProviderCaps } from '../src/usage.js';

const floors: ClaudeFloors = { neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 };

const claudeCaps = (rows: Array<{ id: string; used: number | null; used7d?: number | null }>): ProviderCaps => ({
  provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1,
  fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
  windows: {}, noteCodes: [], activeAccount: null,
  accounts: rows.map(({ id, used, used7d = null }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: used7d, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false })),
});
const accts: ClaudeAccount[] = [{ id: 'a', configDir: null }, { id: 'b', configDir: '/x/.claude-b' }];

describe('claude floors (HED-261)', () => {
  it('reads the floors from the ratified lanes.yaml', () => {
    const lanes = loadLanes(join(process.cwd(), 'routing/lanes.yaml'));
    expect(claudeFloorsFrom(lanes)).toEqual({ neverBelowPct: 3, residencyCapBelowPct: 10, residencyMax: 2 });
  });

  it.each([150, -1])('rejects an out-of-range never_below_pct (%s)', (neverBelowPct) => {
    const lanes = loadLanes(join(process.cwd(), 'routing/lanes.yaml'));
    lanes.floors.claude.never_below_pct = neverBelowPct;
    expect(() => claudeFloorsFrom(lanes)).toThrow(/never_below_pct.*0.*100/);
  });

  it('rejects invalid residency floor values', () => {
    const lanes = loadLanes(join(process.cwd(), 'routing/lanes.yaml'));
    lanes.floors.claude.residency_cap_below_pct = 101;
    expect(() => claudeFloorsFrom(lanes)).toThrow(/residency_cap_below_pct.*0.*100/);
    lanes.floors.claude.residency_cap_below_pct = 10;
    lanes.floors.claude.residency_max = -1;
    expect(() => claudeFloorsFrom(lanes)).toThrow(/residency_max.*greater than or equal to 0/);
  });

  it('headroom is 100 − used; unknown stays unknown', () => {
    expect(headroomPct(90)).toBe(10);
    expect(headroomPct(0)).toBe(100);
    expect(headroomPct(null)).toBeNull();
  });

  it('regression PR#87 — floors the incident account when 7d is at 98% despite healthy 5h', () => {
    expect(isFloored(50, 98, floors)).toBe(true);
    expect(bindingMeter(50, 98)).toBe('7d');
  });

  it('does not floor a keeper-anchor account whose 7d reading is unknown', () => {
    expect(isFloored(10, null, floors)).toBe(false);
    expect(bindingMeter(10, null)).toBe('5h');
  });

  it('floors an account at or below the headroom floor (INCLUSIVE) — the rollover-scare guard', () => {
    expect(isFloored(98, 50, floors)).toBe(true);   // headroom 2 → floored (the 98% resume the rollover hit)
    expect(isFloored(100, 50, floors)).toBe(true);  // headroom 0 → floored (the 100% resume)
    // boundary: ratified lanes.yaml is "never rotate INTO ≤3%" → INCLUSIVE, so headroom == the floor is floored (R nod 2026-08-22).
    expect(isFloored(97, 50, floors)).toBe(true);   // headroom 3 ≤ 3 → floored
    expect(isFloored(96, 50, floors)).toBe(false);  // headroom 4 > 3 → allowed
    expect(isFloored(50, 50, floors)).toBe(false);
    expect(isFloored(null, null, floors)).toBe(false); // both unknown never decides
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

  it('refuses a pinned account floored only by 7d and names that binding meter', () => {
    const one: ClaudeAccount[] = [{ id: 'a', configDir: null }];
    expect(() => pickClaudeAccount(claudeCaps([{ id: 'a', used: 50, used7d: 98 }]), one, { pin: 'a', floors }))
      .toThrow(/account_pin "a".*5h 50%, 7d 98% → 7d binds.*floor 3%/);
  });

  it('unknown/stale used is NOT floored — the picker still selects (unknown never decides)', () => {
    expect(pickClaudeAccount(claudeCaps([{ id: 'a', used: null }, { id: 'b', used: null }]), accts, { floors })).not.toBeNull();
  });

  it('does not floor from a stale provider snapshot — unknown never decides', () => {
    const caps = { ...claudeCaps([{ id: 'a', used: 99 }]), stale: true };
    const one: ClaudeAccount[] = [{ id: 'a', configDir: null }];
    expect(pickClaudeAccount(caps, one, { floors })?.account.id).toBe('a');
  });

  it('refuses a pinned account at or below the floor', () => {
    const one: ClaudeAccount[] = [{ id: 'a', configDir: null }];
    expect(() => pickClaudeAccount(claudeCaps([{ id: 'a', used: 99 }]), one, { pin: 'a', floors }))
      .toThrow(/account_pin "a".*headroom floor.*5h 99%.*floor 3%/);
  });

  it('returns a healthy pinned account and does not floor a stale pinned snapshot', () => {
    const one: ClaudeAccount[] = [{ id: 'a', configDir: null }];
    expect(pickClaudeAccount(claudeCaps([{ id: 'a', used: 50 }]), one, { pin: 'a', floors })?.account.id).toBe('a');
    const stale = { ...claudeCaps([{ id: 'a', used: 99 }]), stale: true };
    expect(pickClaudeAccount(stale, one, { pin: 'a', floors })?.account.id).toBe('a');
  });
});
