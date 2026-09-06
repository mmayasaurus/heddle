import { isDispatchExcluded, type ClaudeAccount } from './capaware.js';
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
  excluded: boolean;
  residents: number;
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
  caps: ProviderCaps, accounts: ClaudeAccount[], floors: ClaudeFloors, residentsByAccount: ReadonlyMap<string, number> = new Map(),
): ClaudeAccountRow[] {
  return accounts.map((account) => {
    const { usedPct5h, usedPct7d } = valuesFor(caps, account.id);
    const meter = bindingMeter(usedPct5h, usedPct7d);
    const floored = isFloored(usedPct5h, usedPct7d, floors);
    const loggedOut = account.loggedIn === false;
    const dispatchExcluded = isDispatchExcluded(caps, account.id);
    const capsAccount = caps.accounts.find((row) => row.id === account.id);
    const overage = (capsAccount?.overageEnabled ?? account.overageEnabled ?? false) === true;
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
      excluded: floored || loggedOut || dispatchExcluded || overage,
      residents: residentsByAccount.get(account.id) ?? 0,
    };
  });
}

export type BatchAssignment = ClaudePickData | { refused: true; reason: string };

/**
 * Deterministic residency-aware placement. Callers inject the live non-batch census when one exists;
 * this command currently starts at zero because no account-bound session census is available yet.
 */
export function pickClaudeAccountsBatch(
  caps: ProviderCaps, accounts: ClaudeAccount[], floors: ClaudeFloors, agents: readonly string[],
  residentsByAccount: ReadonlyMap<string, number> = new Map(),
): { assignments: Record<string, BatchAssignment>; accounts: ClaudeAccountRow[] } {
  // HED-340 (deferred): seed residents from the live pid-env census once it exposes Claude account
  // bindings — that reader is not built yet, so batch currently starts every account at zero residents.
  const residents = new Map(residentsByAccount);
  const rows = claudeAccountRows(caps, accounts, floors, residents);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const assignments: Record<string, BatchAssignment> = {};
  const ceiling = accounts.length === 0 ? 0 : Math.ceil(agents.length / accounts.length);
  // INCLUSIVE boundary, matching the ratified floor (HED-261, R nod 2026-08-22): the ticket's
  // "≤10%-remaining accounts carry max N" → headroom ≤ residency_cap_below_pct triggers the cap. The
  // field name reads exclusive but the ratified semantic wins, exactly as never_below_pct is inclusive.
  const isAtLowHeadroomCap = (row: ClaudeAccountRow): boolean => row.headroomPct !== null && row.headroomPct <= floors.residencyCapBelowPct &&
    (residents.get(row.account) ?? 0) >= floors.residencyMax;
  const isAtCeiling = (row: ClaudeAccountRow): boolean => ceiling > 0 && (residents.get(row.account) ?? 0) >= ceiling;
  const isAtCap = (row: ClaudeAccountRow): boolean => isAtCeiling(row) || isAtLowHeadroomCap(row);
  const otherwiseEligible = (row: ClaudeAccountRow): boolean => !row.excluded && row.headroomPct !== null;

  for (const agent of agents) {
    const candidates = rows.filter((row) => !row.excluded && row.headroomPct !== null && !isAtCap(row));
    if (candidates.length === 0) {
      const eligibleRows = rows.filter(otherwiseEligible);
      if (eligibleRows.length > 0 && eligibleRows.every(isAtCeiling)) {
        const soonest = [...eligibleRows].sort((a, b) => {
          const aReset = valuesFor(caps, a.account).resetsAt;
          const bReset = valuesFor(caps, b.account).resetsAt;
          return (aReset ?? Infinity) - (bReset ?? Infinity) || a.account.localeCompare(b.account);
        })[0];
        const reset = valuesFor(caps, soonest.account).resetsAt;
        assignments[agent] = {
          refused: true,
          reason: `only ${Object.values(assignments).filter((assignment) => !('refused' in assignment)).length} of ${agents.length} agents placeable until ${soonest.account} resets ${reset ?? 'unknown'}`,
        };
        continue;
      }
      let floored = 0, capped = 0, loggedOut = 0, dispatchExcluded = 0, overage = 0, unmetered = 0;
      for (const row of rows) {
        if (row.loggedOut) loggedOut++;
        else if (row.dispatchExcluded) dispatchExcluded++;
        else if (row.overage) overage++;
        else if (row.floored) floored++;
        else if (isAtCap(row)) capped++;
        else if (row.headroomPct === null) unmetered++;
      }
      assignments[agent] = {
        refused: true,
        reason: `no eligible Claude account: ${floored} floored, ${capped} at residency cap, ${loggedOut} logged-out, ${dispatchExcluded} dispatch-excluded, ${overage} overage, ${unmetered} unmetered`,
      };
      continue;
    }
    candidates.sort((a, b) =>
      (residents.get(a.account) ?? 0) - (residents.get(b.account) ?? 0) ||
      (b.headroomPct ?? -Infinity) - (a.headroomPct ?? -Infinity) ||
      a.account.localeCompare(b.account));
    const selected = candidates[0];
    const account = accountById.get(selected.account)!;
    const { usedPct5h, usedPct7d, resetsAt } = valuesFor(caps, account.id);
    const currentResidents = residents.get(account.id) ?? 0;
    assignments[agent] = {
      account: account.id,
      configDir: account.configDir,
      unsetConfigDir: account.configDir === null,
      usedPct5h,
      usedPct7d,
      bindingMeter: bindingMeter(usedPct5h, usedPct7d),
      resetsAt,
      reason: `account:${account.id} batch placement${rows.filter(otherwiseEligible).length === 1 ? ' (DEGENERATE: every other account floored/vetoed — not a spread)' : ''} (residents ${currentResidents}, headroom ${selected.headroomPct === null ? 'unknown' : `${selected.headroomPct.toFixed(0)}%`})`,
      for: agent,
    };
    residents.set(account.id, currentResidents + 1);
    selected.residents = currentResidents + 1;
  }
  return { assignments, accounts: rows };
}
