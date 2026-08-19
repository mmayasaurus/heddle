import { readClaudeAccounts, currentClaudeAccount, pickClaudeAccount, type ClaudeAccount } from '../capaware.js';
import { readProviderCaps } from '../usage.js';
import type { ProviderCaps } from '../usage.js';

/**
 * Interactive-session account rotator — the DECISION layer (HED-117).
 *
 * Pure over its inputs so the supervisor's state machine can be tested without a live fleet. It
 * answers one question — "should the fleet rotate to another Claude account, and to which?" — by
 * reusing the SAME selection the dispatch router uses (`pickClaudeAccount`), so the rotator and
 * dispatch can never disagree on which account has headroom. The orchestration (pause → quiesce →
 * relaunch → resume) lives in the supervisor; this module only decides.
 */

/** Utilisation thresholds, in percent, for the 5h and 7d (weekly) caps. Defaults match Maya's ask:
 *  watch at 80, rotate at 90, for both windows. */
export interface RotateThresholds {
  /** At/above this the fleet is close — logged, and (once wired) new dispatches are discouraged. */
  softPct: number;
  /** At/above this the fleet MUST rotate before the cap is hit mid-turn. */
  hardPct: number;
  /** Same as softPct, for the WEEKLY (7-day) cap — the window-keeper's staggering can keep 5h
   *  healthy while the weekly climbs, so it must be checked independently (HED-190). */
  soft7dPct: number;
  /** Same as hardPct, for the WEEKLY (7-day) cap. */
  hard7dPct: number;
}

export const DEFAULT_THRESHOLDS: RotateThresholds = { softPct: 80, hardPct: 90, soft7dPct: 80, hard7dPct: 90 };

export type RotateAction =
  | { action: 'idle'; current: string | null; usedPct: number | null; reason: string }
  | { action: 'watch'; current: string; usedPct: number; reason: string }
  | { action: 'rotate'; current: string; usedPct: number; target: ClaudeAccount; targetEnv: { env: Record<string, string>; envUnset: string[] }; reason: string }
  | { action: 'exhausted'; current: string; usedPct: number; reason: string }
  | { action: 'unknown'; current: string | null; usedPct: null; reason: string };

/** The ladder the two windows are compared on — the higher number is the more urgent action. */
const URGENCY = { idle: 0, watch: 1, rotate: 2 } as const;
type Urgency = keyof typeof URGENCY;
type Band = { urgency: Urgency; pct: number; by7d: boolean };

/**
 * Band the 5h and WEEKLY windows INDEPENDENTLY and return the more urgent of the two (HED-190).
 * A null 7d contributes no band at all: it can neither trigger nor block. A TIE keeps the 5h band —
 * the two are then asking for the same action anyway, and `by7d` decides how the target is chosen,
 * so the weekly path is entered only when the weekly window is what actually escalated.
 * (Extracted from `decideRotation` on review — codacy flagged the length/complexity delta.)
 */
function mostUrgentBand(usedPct: number, usedPct7d: number | null, t: RotateThresholds): Band {
  const band = (pct: number, soft: number, hard: number): Urgency =>
    pct >= hard ? 'rotate' : pct >= soft ? 'watch' : 'idle';
  const fiveHour: Band = { urgency: band(usedPct, t.softPct, t.hardPct), pct: usedPct, by7d: false };
  if (usedPct7d === null) return fiveHour;
  const sevenDay: Band = { urgency: band(usedPct7d, t.soft7dPct, t.hard7dPct), pct: usedPct7d, by7d: true };
  return URGENCY[sevenDay.urgency] > URGENCY[fiveHour.urgency] ? sevenDay : fiveHour;
}

/**
 * Decide from already-loaded caps + registry. Split from `readAndDecide` so tests drive it with
 * fixtures and never touch the real `~/.heddle` files.
 *
 * The ordering of the guards matters:
 *  - unknown current utilisation → do NOTHING (never rotate blind; a stale/absent reading is not 0%);
 *  - below soft → idle; soft..hard → watch (no action yet);
 *  - at/above hard → pick the best account. If the picker returns the account we are already on,
 *    every account is near the cap, so this is `exhausted` (a needs-human), NOT a pointless
 *    self-rotate onto an equally-dead account.
 *
 * HED-190: the same idle/watch/rotate bands are also evaluated against the WEEKLY (7-day) cap, and
 * the OVERALL action is the more urgent of the two — the window-keeper's staggering can keep 5h
 * healthy while the weekly climbs, so a 5h-only trigger would miss that case. A null 7d reading
 * never moves the decision either way. Target selection FOLLOWS the window that triggered: a
 * weekly-triggered rotation ranks candidates by weekly headroom and refuses a weekly-dead target
 * (see the `pickClaudeAccount` call below).
 */
export function decideRotation(
  caps: ProviderCaps | undefined,
  accounts: ClaudeAccount[],
  env: NodeJS.ProcessEnv,
  thresholds: RotateThresholds = DEFAULT_THRESHOLDS,
): RotateAction {
  // A provider snapshot that is stale/absent at the PROVIDER level is unusable regardless of the
  // per-row flags — mirrors adviseClaudeAccount. Never rotate (or declare idle) on it.
  const capsUsable = caps !== undefined && !caps.stale && caps.source !== 'none';
  // HED-165 (codex P1): a tap-only snapshot — mirror absent OR stale, so readProviderCaps fell back to
  // readClaudeTap wholesale — NEVER names the fleet's active account (readClaudeTap sets activeAccount
  // null). The only "current" we could then derive is the rotator DAEMON's own CLAUDE_CONFIG_DIR, which
  // (see the next comment) is unrelated to the fleet — so acting on it could pause/kill/relaunch the
  // WRONG account. With usable caps but no authoritative fleet account, refuse to guess. NOTE: because
  // idle-account visibility now flows through the keeper anchors in this same merged source, a
  // persistently `unknown`/empty result here can mean the KEEPER is down (stale anchors) or the MIRROR
  // is down — not necessarily that the accounts are exhausted.
  if (capsUsable && caps.activeAccount === null && caps.source === 'claude-tap') {
    return { action: 'unknown', current: null, usedPct: null, reason: 'usable tap-only caps but no authoritative active account (mirror absent/stale) — cannot identify the fleet account to rotate' };
  }
  // The FLEET's active account, from the tap (authoritative), NOT the rotator's own CLAUDE_CONFIG_DIR
  // — the rotator is a standalone process whose env account is unrelated to the fleet's. Fall back to
  // the env-derived account only when the tap does not name one.
  const currentId = (capsUsable && caps.activeAccount) ? caps.activeAccount : (currentClaudeAccount(accounts, env)?.id ?? null);
  const usedRow = currentId && capsUsable ? caps.accounts.find((r) => r.id === currentId) : undefined;
  const usedPct = usedRow && !usedRow.stale ? usedRow.fiveHour.usedPercentage : null;
  // Same read as usedPct, for the WEEKLY cap (HED-190) — gated by the SAME staleness flag as the 5h
  // read. Never its own signal for "unknown": a null 7d simply means no 7d sub-decision below.
  const usedPct7d = usedRow && !usedRow.stale ? usedRow.sevenDay.usedPercentage : null;

  if (currentId === null) {
    return { action: 'unknown', current: null, usedPct: null, reason: 'current account not resolvable from the tap activeAccount or CLAUDE_CONFIG_DIR / registry' };
  }
  if (usedPct === null) {
    // A stale or absent 5h reading is NOT zero — rotating (or declaring idle) on unknown data is
    // exactly the blind decision this must avoid. Wait for a fresh capture from the tap/keeper. A
    // 7d reading (fresh or not) never overrides this: without a fresh 5h capture the row is untrusted.
    return { action: 'unknown', current: currentId, usedPct: null, reason: `no fresh 5h capture for ${currentId} — not deciding` };
  }

  // Band each window independently, then the OVERALL action is the MORE URGENT of the two
  // (rotate > watch > idle) — the weekly cap must be able to force a rotation the 5h view alone
  // would miss, and vice versa. A null 7d contributes no band: it can neither trigger nor block.
  const winner = mostUrgentBand(usedPct, usedPct7d, thresholds);
  const by7d = winner.by7d;

  if (winner.urgency === 'idle') {
    return { action: 'idle', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (< ${thresholds.softPct}% soft)` };
  }
  if (winner.urgency === 'watch') {
    if (by7d) {
      return { action: 'watch', current: currentId, usedPct, reason: `${currentId} at ${winner.pct.toFixed(0)}% 7d (>= ${thresholds.soft7dPct}% soft 7d, < ${thresholds.hard7dPct}% hard 7d)` };
    }
    return { action: 'watch', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (>= ${thresholds.softPct}% soft, < ${thresholds.hardPct}% hard)` };
  }

  // winner.urgency === 'rotate'. Target selection follows the window that TRIGGERED (HED-190 review,
  // flagged P1 by four reviewers): picking by 5h headroom alone when the WEEKLY cap fired can hand the
  // fleet an account that is itself at the weekly wall — 5h-idle today, out of weekly allowance — and
  // the relaunched fleet hits that wall on its first turn. `prefer7d` ranks by weekly headroom (5h
  // stays a hard constraint and the tie-break) and `routeAwayAt7dPct` marks a weekly-dead target so
  // the guard below can see it. A 5h-triggered rotate keeps the 5h ranking exactly as before.
  const pick = pickClaudeAccount(caps, accounts, {
    routeAwayAtPct: thresholds.hardPct,
    ...(by7d ? { prefer7d: true, routeAwayAt7dPct: thresholds.hard7dPct } : {}),
  });
  const trigger = by7d ? `7d ${winner.pct.toFixed(0)}%` : `${usedPct.toFixed(0)}%`;
  // Which cap the operator-facing "everything is full" wording should name (codacy: saying "near the
  // cap" on a weekly-triggered decision reads as though the 5h window were the problem).
  const cap = by7d ? 'the weekly (7d) cap' : 'the cap';
  if (!pick) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger} and no account is selectable` };
  }
  if (pick.account.id === currentId) {
    // The best account IS the current one — every alternative is worse or unusable. Rotating would
    // land us back where we are (or somewhere equally dead), so the operator must decide. Under a
    // weekly trigger the ranking above is weekly-first, so "still the best" now means it genuinely
    // has the most WEEKLY headroom, not merely the most 5h headroom of a weekly-dead field.
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger} is still the best account — all Claude accounts are near ${cap}` };
  }
  // The best OTHER account is itself at/over the hard cap — rotating there just hits the wall again.
  if (pick.usedPct !== null && pick.usedPct >= thresholds.hardPct) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger}; best alternative ${pick.account.id} is also at ${pick.usedPct.toFixed(0)}% (>= ${thresholds.hardPct}% hard) — all accounts near the cap` };
  }
  // The same guard for the WEEKLY window, and deliberately ONLY under a weekly trigger: the pick was
  // then ranked weekly-first, so a target still at/over the 7d hard threshold proves EVERY addressable
  // account is (the tiers above it were empty) — the all-accounts-weekly-exhausted edge the 5h guard
  // cannot see, and a needs-human rather than a rotation that changes nothing. On a 5h-triggered
  // rotate the ranking is 5h-first, so a weekly-dead pick says nothing about the other accounts and
  // rejecting it here would be a FALSE exhausted (the mirror image of the bug this fix removes).
  if (by7d && pick.usedPct7d !== null && pick.usedPct7d >= thresholds.hard7dPct) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger}; best alternative ${pick.account.id} is also at 7d ${pick.usedPct7d.toFixed(0)}% (>= ${thresholds.hard7dPct}% hard 7d) — all accounts are near the weekly cap` };
  }
  return {
    action: 'rotate', current: currentId, usedPct, target: pick.account,
    targetEnv: { env: pick.env, envUnset: pick.envUnset },
    reason: `rotate ${currentId} (${trigger}) → ${pick.account.id} (${pick.reason})`,
  };
}

/** Load the live tap + registry and decide. `usageDir` and `accountsPath` are injectable for tests. */
export function readAndDecide(opts: {
  usageDir: string;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
  accountsPath?: string;
  thresholds?: RotateThresholds;
}): RotateAction {
  const env = opts.env ?? process.env;
  const accounts = readClaudeAccounts(opts.accountsPath);
  // Read the SAME merged source the dispatch router uses (readProviderCaps), NOT readLimitsMirror
  // alone (HED-165). The limits.json mirror carries idle accounts as usedPercentage:null + stale:true,
  // but readClaudeTap's keeper anchors normalize a keeper-pinged idle account to 0% (fresh) and
  // readProviderCaps merges that over the stale mirror row — so pickClaudeAccount can actually SELECT
  // the idle accounts the rotator must rotate TO. Reading the mirror only made the rotator blind to
  // exactly those accounts and disagree with the dispatch router this module's selection is meant to
  // mirror. readProviderCaps always returns a 'claude' entry (source:'none' when nothing is usable),
  // which decideRotation's capsUsable guard treats as unknown — same as the old undefined.
  const caps = readProviderCaps({ usageDir: opts.usageDir, nowS: Math.floor(opts.nowMs / 1000) })['claude'];
  return decideRotation(caps, accounts, env, opts.thresholds);
}
