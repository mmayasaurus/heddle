import { envRepointPinOnly, isDispatchExcluded, type ClaudeAccount } from './capaware.js';
import { bindingMeter, headroomPct, isFloored, type ClaudeFloors } from './floors.js';
import { LIMITS_JSON_MAX_AGE_S, type ProviderCaps } from './usage.js';

export interface ClaudePickData {
  account: string;
  configDir: string | null;
  unsetConfigDir: boolean;
  usedPct5h: number | null;
  usedPct7d: number | null;
  bindingMeter: '5h' | '7d' | null;
  resetsAt: number | null;
  reason: string;
  for?: string;
}

export interface ClaudeAccountRow {
  account: string;
  usedPct5h: number | null;
  usedPct7d: number | null;
  headroomPct: number | null;
  bindingMeter: '5h' | '7d' | null;
  floored: boolean;
  loggedOut: boolean;
  dispatchExcluded: boolean;
  overage: boolean;
  /** HED-698: an env-repoint account (GLM, Kimi, …) in a registry that also holds a native account is pin-only. */
  envRepointPinOnly: boolean;
  excluded: boolean;
  /** Resident count remains the HED-261 low-headroom-cap input. */
  residents: number;
  /** Weighted resident load is the LPT placement input. */
  residentWeight: number;
}

export function usableClaudeCaps(caps: ProviderCaps | undefined, nowS = Math.floor(Date.now() / 1000)):
  | { usable: true; caps: ProviderCaps }
  | { usable: false; age: string } {
  const capturedAt = caps?.capturedAt ?? null;
  const ageS = capturedAt === null ? null : Math.max(0, nowS - capturedAt);
  if (!caps || caps.source === 'none' || caps.stale || ageS === null || ageS > LIMITS_JSON_MAX_AGE_S) {
    return {
      usable: false,
      age: ageS === null ? 'unknown (capturedAt unavailable)' : `${ageS}s (capturedAt ${capturedAt}, budget ${LIMITS_JSON_MAX_AGE_S}s)`,
    };
  }
  return { usable: true, caps };
}

function valuesFor(caps: ProviderCaps, id: string): { usedPct5h: number | null; usedPct7d: number | null; resetsAt: number | null } {
  const row = caps.accounts.find((account) => account.id === id);
  const usedPct5h = row && !row.stale ? row.fiveHour.usedPercentage : null;
  const usedPct7d = row && !row.stale ? row.sevenDay.usedPercentage : null;
  const meter = bindingMeter(usedPct5h, usedPct7d);
  return {
    usedPct5h,
    usedPct7d,
    resetsAt: meter === '5h' ? row?.fiveHour.resetsAt ?? null : meter === '7d' ? row?.sevenDay.resetsAt ?? null : null,
  };
}

export function claudeAccountRows(
  caps: ProviderCaps, accounts: ClaudeAccount[], floors: ClaudeFloors, residentsByAccount: ReadonlyMap<string, ResidentLoad> = new Map(),
): ClaudeAccountRow[] {
  // HED-698: fleet placement is an automatic pick, so beside a native account an env-repoint row is never
  // a placement target (a seat launched on it would run another family, or a native CLI with no login).
  const pinOnly = envRepointPinOnly(accounts);
  return accounts.map((account) => {
    const { usedPct5h, usedPct7d } = valuesFor(caps, account.id);
    const meter = bindingMeter(usedPct5h, usedPct7d);
    const floored = isFloored(usedPct5h, usedPct7d, floors);
    const loggedOut = account.loggedIn === false;
    const dispatchExcluded = isDispatchExcluded(caps, account.id);
    const capsAccount = caps.accounts.find((row) => row.id === account.id);
    // A caps-row overage flag is authoritative only while the row is FRESH; a stale poll's flag is
    // obsolete and must fall through to the durable registry value, never override it (codeant HED-446).
    const overage = ((capsAccount && !capsAccount.stale ? capsAccount.overageEnabled : undefined) ?? account.overageEnabled ?? false) === true;
    const pinOnlyRow = pinOnly(account);
    return {
      account: account.id,
      usedPct5h,
      usedPct7d,
      headroomPct: meter === '5h' ? headroomPct(usedPct5h) : meter === '7d' ? headroomPct(usedPct7d) : null,
      bindingMeter: meter,
      floored,
      loggedOut,
      dispatchExcluded,
      overage,
      envRepointPinOnly: pinOnlyRow,
      excluded: floored || loggedOut || dispatchExcluded || overage || pinOnlyRow,
      residents: residentsByAccount.get(account.id)?.count ?? 0,
      residentWeight: residentsByAccount.get(account.id)?.weight ?? 0,
    };
  });
}

export type BatchAssignment = ClaudePickData | { refused: true; reason: string };
export interface ResidentLoad { count: number; weight: number; }

/**
 * Deterministic weighted-LPT placement. Counts are retained only for the HED-261 low-headroom cap.
 */
export function pickClaudeAccountsBatch(
  caps: ProviderCaps, accounts: ClaudeAccount[], floors: ClaudeFloors, agents: readonly string[],
  residentsByAccount: ReadonlyMap<string, ResidentLoad> = new Map(),
  weightOf: (letter: string) => number = () => 1,
): { assignments: Record<string, BatchAssignment>; accounts: ClaudeAccountRow[] } {
  const residents = new Map([...residentsByAccount].map(([account, load]) => [account, { ...load }]));
  const rows = claudeAccountRows(caps, accounts, floors, residents);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const assignments: Record<string, BatchAssignment> = {};
  // INCLUSIVE boundary, matching the ratified floor (HED-261, R nod 2026-08-22): the ticket's
  // "≤10%-remaining accounts carry max N" → headroom ≤ residency_cap_below_pct triggers the cap. The
  // field name reads exclusive but the ratified semantic wins, exactly as never_below_pct is inclusive.
  const isAtLowHeadroomCap = (row: ClaudeAccountRow): boolean => row.headroomPct !== null && row.headroomPct <= floors.residencyCapBelowPct &&
    (residents.get(row.account)?.count ?? 0) >= floors.residencyMax;
  const otherwiseEligible = (row: ClaudeAccountRow): boolean => !row.excluded && row.headroomPct !== null;

  for (const agent of [...agents].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))) {
    const candidates = rows.filter((row) => otherwiseEligible(row) && !isAtLowHeadroomCap(row));
    if (candidates.length === 0) {
      const eligibleRows = rows.filter(otherwiseEligible);
      if (eligibleRows.length > 0 && eligibleRows.every(isAtLowHeadroomCap)) {
        const placed = Object.values(assignments).filter((assignment) => !('refused' in assignment)).length;
        // A floored account becoming healthy is the only reset event that can add a new eligible bin.
        const unblocker = rows
          .filter((row) => row.floored && !row.loggedOut && !row.dispatchExcluded && !row.overage)
          .map((row) => ({ account: row.account, reset: valuesFor(caps, row.account).resetsAt }))
          .sort((a, b) => (a.reset ?? Infinity) - (b.reset ?? Infinity) || a.account.localeCompare(b.account))[0];
        assignments[agent] = {
          refused: true,
          reason: unblocker
            ? `only ${placed} of ${agents.length} agents placeable until ${unblocker.account} resets ${unblocker.reset ?? 'unknown'}`
            : `no eligible Claude account: all metered, non-excluded accounts are at the residency cap`,
        };
        continue;
      }
      let floored = 0, capped = 0, loggedOut = 0, dispatchExcluded = 0, overage = 0, unmetered = 0, pinOnly = 0;
      for (const row of rows) {
        if (row.envRepointPinOnly) pinOnly++;
        else if (row.loggedOut) loggedOut++;
        else if (row.dispatchExcluded) dispatchExcluded++;
        else if (row.overage) overage++;
        else if (row.floored) floored++;
        else if (isAtLowHeadroomCap(row)) capped++;
        else if (row.headroomPct === null) unmetered++;
      }
      assignments[agent] = {
        refused: true,
        reason: `no eligible Claude account: ${floored} floored, ${capped} at residency cap, ${loggedOut} logged-out, ${dispatchExcluded} dispatch-excluded, ${overage} overage, ${unmetered} unmetered, ${pinOnly} env-repoint pin-only`,
      };
      continue;
    }
    candidates.sort((a, b) =>
      (residents.get(a.account)?.weight ?? 0) - (residents.get(b.account)?.weight ?? 0) ||
      (b.headroomPct ?? -Infinity) - (a.headroomPct ?? -Infinity) ||
      a.account.localeCompare(b.account));
    const selected = candidates[0];
    const account = accountById.get(selected.account)!;
    const { usedPct5h, usedPct7d, resetsAt } = valuesFor(caps, account.id);
    const currentResidents = residents.get(account.id) ?? { count: 0, weight: 0 };
    assignments[agent] = {
      account: account.id,
      configDir: account.configDir,
      unsetConfigDir: account.configDir === null,
      usedPct5h,
      usedPct7d,
      bindingMeter: bindingMeter(usedPct5h, usedPct7d),
      resetsAt,
      reason: `account:${account.id} batch placement${rows.filter(otherwiseEligible).length === 1 ? ' (DEGENERATE: every other account floored/vetoed — not a spread)' : ''} (residents ${currentResidents.count}, weighted load ${currentResidents.weight}, headroom ${selected.headroomPct === null ? 'unknown' : `${selected.headroomPct.toFixed(0)}%`})`,
      for: agent,
    };
    const next = { count: currentResidents.count + 1, weight: currentResidents.weight + weightOf(agent) };
    residents.set(account.id, next);
    selected.residents = next.count;
    selected.residentWeight = next.weight;
  }
  return { assignments, accounts: rows };
}
