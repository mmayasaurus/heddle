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

/** A 5h window resetting within this long counts as empty for a switch pick: it refills before a
 *  session moved onto it can use much of what is left… */
export const SWITCH_RESET_SOON_S = 30 * 60;
/** …provided more than this much headroom is left on it now, enough to carry the session until the
 *  reset. (So a caller that moves sessions off an account at 85% of its 5h window is never handed a
 *  credited window it would move straight off again.) */
export const SWITCH_RESET_SOON_MIN_ROOM_PCT = 15;

/** A switch pick: the single-pick shape, plus what it was ranked on. */
export interface SwitchPickData extends ClaudePickData {
  /** Headroom on the tighter window, a 5h window resetting soon counting as empty. */
  roomPct: number;
  /** Sessions already on the login (counted, not weighted); null when the census was unavailable. */
  residents: number | null;
}

/** An account row of a switch pick. */
export interface SwitchAccountRow extends ClaudeAccountRow {
  /** On the login being left, so never a candidate. */
  leaving: boolean;
}

/**
 * The account to move a running session onto (`heddle account pick --leaving`). Where the plain single
 * pick takes the most 5h headroom, this ranks LOGINS:
 * - folders logged into one login draw on one usage pool, so they are one candidate, and the login
 *   being left is never a candidate, whichever of its folders the session ran in;
 * - a login's room is its headroom on the tighter of its two windows, by the tightest reading any of
 *   its folders has, a 5h window that resets within SWITCH_RESET_SOON_S counting as empty while it has
 *   more than SWITCH_RESET_SOON_MIN_ROOM_PCT left; the pick reports that reading's meters;
 * - that room is shared with the sessions already on the login: the pick has the most room per seat
 *   (room ÷ (weighted sessions + 1)), then the most room, then the lowest account id.
 * What is true of the pool takes the whole login out: a floored reading, overage billing, or a billing
 * failure, on any of its folders. What is true of one folder (logged out, a logged-out dispatch
 * signal, env-repoint pin-only) only rules out moving into that folder: the login is picked through
 * its first folder in registry order that isn't ruled out, and needs at least one reading.
 * `residents` null = the census was unavailable: rank on room alone.
 */
export function pickClaudeAccountToSwitch(
  caps: ProviderCaps, accounts: ClaudeAccount[], floors: ClaudeFloors,
  opts: {
    leaving: string;
    loginOf: (account: ClaudeAccount) => string;
    residents: ReadonlyMap<string, ResidentLoad> | null;
    nowS: number;
  },
): { pick: SwitchPickData; rows: SwitchAccountRow[] } | { pick: null; reason: string; rows: SwitchAccountRow[] } {
  const loginKeys = accounts.map((account) => opts.loginOf(account));
  const rows: SwitchAccountRow[] = claudeAccountRows(caps, accounts, floors)
    .map((row, index) => ({ ...row, leaving: loginKeys[index] === opts.leaving }));
  interface Login {
    /** The folder a session would move into. */
    into: ClaudeAccount | null;
    /** The reading with the least room, on any of the login's folders. */
    tightest: { id: string; room: number; resetsSoon: boolean } | null;
    barred: boolean;
  }
  const logins = new Map<string, Login>();
  let left = 0;
  for (const [index, account] of accounts.entries()) {
    const row = rows[index];
    if (row.leaving) {
      left++;
      continue;
    }
    const login = logins.get(loginKeys[index]) ?? { into: null, tightest: null, barred: false };
    logins.set(loginKeys[index], login);
    const capsRow = caps.accounts.find((candidate) => candidate.id === account.id);
    if (row.floored || row.overage || (row.dispatchExcluded && capsRow?.dispatch?.reason === 'billing')) login.barred = true;
    if (!row.excluded && !login.into) login.into = account;
    if (row.headroomPct === null) continue;
    const reset5h = capsRow?.fiveHour.resetsAt ?? null;
    // (A window whose reset has already passed reads 0% used: readProviderCaps rolled it over.)
    const resetsSoon = row.usedPct5h !== null && 100 - row.usedPct5h > SWITCH_RESET_SOON_MIN_ROOM_PCT &&
      reset5h !== null && reset5h > opts.nowS && reset5h <= opts.nowS + SWITCH_RESET_SOON_S;
    const room = Math.min(...[resetsSoon ? 0 : row.usedPct5h, row.usedPct7d]
      .filter((used): used is number => used !== null)
      .map((used) => 100 - used));
    if (!login.tightest || room < login.tightest.room) login.tightest = { id: account.id, room, resetsSoon };
  }
  const candidates = [...logins.entries()].flatMap(([key, { into, tightest, barred }]) =>
    (into && tightest && !barred ? [{ key, into, tightest }] : []));
  if (candidates.length === 0) {
    return {
      pick: null,
      rows,
      reason: `no other login has a usable account: ${left} account(s) on the login being left, ` +
        `${accounts.length - left} on logins ruled out (floored, overage or a billing failure on any of a login's ` +
        `folders, or every folder logged out, pin-only or unmetered)`,
    };
  }
  const weightOn = (key: string) => opts.residents?.get(key)?.weight ?? 0;
  candidates.sort((a, b) =>
    b.tightest.room / (weightOn(b.key) + 1) - a.tightest.room / (weightOn(a.key) + 1) ||
    b.tightest.room - a.tightest.room ||
    a.into.id.localeCompare(b.into.id));
  const { key, into, tightest } = candidates[0];
  const residents = opts.residents === null ? null : opts.residents.get(key)?.count ?? 0;
  const { usedPct5h, usedPct7d, resetsAt } = valuesFor(caps, tightest.id);
  const fmt = (pct: number | null) => (pct === null ? 'unknown' : `${pct.toFixed(0)}%`);
  return {
    rows,
    pick: {
      account: into.id,
      configDir: into.configDir,
      unsetConfigDir: into.configDir === null,
      usedPct5h,
      usedPct7d,
      bindingMeter: bindingMeter(usedPct5h, usedPct7d),
      resetsAt,
      roomPct: tightest.room,
      residents,
      reason: `account:${into.id} switch pick (room ${tightest.room.toFixed(0)}%, ` +
        `${residents === null ? 'sessions there unknown' : `${residents} session(s) there`}; ` +
        `5h ${fmt(usedPct5h)}${tightest.resetsSoon ? `, resetting within ${SWITCH_RESET_SOON_S / 60} min` : ''}, ` +
        `7d ${fmt(usedPct7d)}${tightest.id === into.id ? '' : `, as ${tightest.id} reads them`}; ` +
        `best of ${candidates.length} login(s))`,
    },
  };
}

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
