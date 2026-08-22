import type { LanesConfig } from './lanes.js';

/**
 * HED-261 / HED-333 — the SINGLE definition of "is this claude account healthy enough to route/resume
 * onto". The mechanism lives here + on pickClaudeAccount's OPT-IN `opts.floors`. In THIS increment only
 * the `heddle account pick` CLI passes it — the relaunch fix, closing the drift that resumed agents onto
 * 98%/100% accounts. decideRoute's DISPATCH callers (claudeRouteDead, planDispatch, the runtime
 * fallback, src/rotate) do NOT pass floors yet, so the ROUTER is not floor-aware in this increment —
 * wiring floors into every one of those callers (so a near-exhausted account is dead for dispatch too,
 * and the S1 walk expands off it) is HED-340, done as one "every caller" pass with characterization,
 * alongside the residency cap. This file is that one shared definition either way.
 *
 * Floors come from lanes.yaml (`floors.claude`, ratified). This module is pure over (used%, floors).
 */
export interface ClaudeFloors {
  /** Never SELECT an account whose 5h HEADROOM is below this (headroom = 100 − used%). */
  neverBelowPct: number;
  /** An account with headroom below this carries at most `residencyMax` concurrent agents (residency increment). */
  residencyCapBelowPct: number;
  residencyMax: number;
}

/** Read the claude floors from lanes.yaml — the one ratified source both consumers load. */
export function claudeFloorsFrom(lanes: LanesConfig): ClaudeFloors {
  const { never_below_pct, residency_cap_below_pct, residency_max } = lanes.floors.claude;
  if (never_below_pct < 0 || never_below_pct > 100) {
    throw new Error('lanes config: floors.claude.never_below_pct must be between 0 and 100');
  }
  if (residency_cap_below_pct < 0 || residency_cap_below_pct > 100) {
    throw new Error('lanes config: floors.claude.residency_cap_below_pct must be between 0 and 100');
  }
  if (residency_max < 0) {
    throw new Error('lanes config: floors.claude.residency_max must be greater than or equal to 0');
  }
  return { neverBelowPct: never_below_pct, residencyCapBelowPct: residency_cap_below_pct, residencyMax: residency_max };
}

/** Headroom remaining on an account: 100 − used%. null used (unknown/stale) → null (unknown never decides). */
export function headroomPct(usedPct: number | null): number | null {
  return usedPct === null ? null : 100 - usedPct;
}

/**
 * Is this account FLOORED — too close to exhaustion to route or resume onto? True when its fresh 5h
 * headroom is at or below `neverBelowPct` (INCLUSIVE): headroom ≤ never_below_pct → floored, so at
 * pct=3, used ≥ 97% is floored. The field NAME "never_below" reads exclusive, but the RATIFIED
 * lanes.yaml semantic (canonical on HED-106) is "never rotate INTO ≤3%" — inclusive — and the ratified
 * text wins; this comment is the tie-break record (R nod 2026-08-22). Unknown/stale used is NOT floored
 * — unknown never decides, the same discipline every other cap follows. This is the property that would
 * have stopped the rollover from resuming onto a 98%/100% account.
 */
export function isFloored(usedPct: number | null, floors: ClaudeFloors): boolean {
  const headroom = headroomPct(usedPct);
  return headroom !== null && headroom <= floors.neverBelowPct;
}
