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
 * never moves the decision either way. Target selection stays 5h-headroom-based regardless of which
 * window triggered (see the comment at the `pickClaudeAccount` call below).
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
  const URGENCY = { idle: 0, watch: 1, rotate: 2 } as const;
  const band = (pct: number, soft: number, hard: number): keyof typeof URGENCY =>
    pct >= hard ? 'rotate' : pct >= soft ? 'watch' : 'idle';
  const fiveHourBand = { urgency: band(usedPct, thresholds.softPct, thresholds.hardPct), pct: usedPct };
  const sevenDayBand = usedPct7d === null ? null : { urgency: band(usedPct7d, thresholds.soft7dPct, thresholds.hard7dPct), pct: usedPct7d };
  const winner = sevenDayBand !== null && URGENCY[sevenDayBand.urgency] > URGENCY[fiveHourBand.urgency] ? sevenDayBand : fiveHourBand;
  const by7d = winner === sevenDayBand;

  if (winner.urgency === 'idle') {
    return { action: 'idle', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (< ${thresholds.softPct}% soft)` };
  }
  if (winner.urgency === 'watch') {
    if (by7d) {
      return { action: 'watch', current: currentId, usedPct, reason: `${currentId} at ${winner.pct.toFixed(0)}% 7d (>= ${thresholds.soft7dPct}% soft 7d, < ${thresholds.hard7dPct}% hard 7d)` };
    }
    return { action: 'watch', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (>= ${thresholds.softPct}% soft, < ${thresholds.hardPct}% hard)` };
  }

  // winner.urgency === 'rotate', whether the 5h or the 7d window forced it. Target selection is
  // UNCHANGED: pickClaudeAccount always picks by 5h headroom — a fresh idle target is also 7d-fresh,
  // so it relieves the weekly pressure too; a 7d-aware picker is a future refinement, out of scope.
  const pick = pickClaudeAccount(caps, accounts, { routeAwayAtPct: thresholds.hardPct });
  const trigger = by7d ? `7d ${winner.pct.toFixed(0)}%` : `${usedPct.toFixed(0)}%`;
  if (!pick) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger} and no account is selectable` };
  }
  if (pick.account.id === currentId) {
    // The best account IS the current one — every alternative is worse or unusable. Rotating would
    // land us back where we are (or somewhere equally dead), so the operator must decide.
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger} is still the best account — all Claude accounts are near the cap` };
  }
  // The best OTHER account is itself at/over the hard cap — rotating there just hits the wall again.
  if (pick.usedPct !== null && pick.usedPct >= thresholds.hardPct) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${trigger}; best alternative ${pick.account.id} is also at ${pick.usedPct.toFixed(0)}% (>= ${thresholds.hardPct}% hard) — all accounts near the cap` };
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
