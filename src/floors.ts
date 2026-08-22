import type { LanesConfig } from './lanes.js';

/**
 * HED-261 / HED-333 — the SINGLE definition of "is this claude account healthy enough to route/resume
 * onto", shared by BOTH decideRoute's account picker (src/capaware.ts pickClaudeAccount) AND the
 * relaunch wrapper (via the `heddle account pick` CLI). One implementation so the two can never drift
 * on what "healthy" means — the drift that let the rollover resume agents onto 98%/100% accounts.
 *
 * Floors come from lanes.yaml (`floors.claude`, ratified). This module is pure over (used%, floors);
 * the residency cap (concurrent-agent count per account, from a pid-census + the ledger) is a separate
 * source folded in by a later increment — this file owns the ACCOUNT-LEVEL headroom floor.
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
  return {
    neverBelowPct: lanes.floors.claude.never_below_pct,
    residencyCapBelowPct: lanes.floors.claude.residency_cap_below_pct,
    residencyMax: lanes.floors.claude.residency_max,
  };
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
