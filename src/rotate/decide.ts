import { readClaudeAccounts, currentClaudeAccount, pickClaudeAccount, type ClaudeAccount } from '../capaware.js';
import { readLimitsMirror } from '../usage.js';
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

/** 5h utilisation thresholds, in percent. Defaults match Maya's ask: watch at 80, rotate at 90. */
export interface RotateThresholds {
  /** At/above this the fleet is close — logged, and (once wired) new dispatches are discouraged. */
  softPct: number;
  /** At/above this the fleet MUST rotate before the cap is hit mid-turn. */
  hardPct: number;
}

export const DEFAULT_THRESHOLDS: RotateThresholds = { softPct: 80, hardPct: 90 };

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
 */
export function decideRotation(
  caps: ProviderCaps | undefined,
  accounts: ClaudeAccount[],
  env: NodeJS.ProcessEnv,
  thresholds: RotateThresholds = DEFAULT_THRESHOLDS,
): RotateAction {
  const cur = currentClaudeAccount(accounts, env);
  const currentId = cur?.id ?? null;
  const usedRow = cur && caps ? caps.accounts.find((r) => r.id === cur.id) : undefined;
  const usedPct = usedRow && !usedRow.stale ? usedRow.fiveHour.usedPercentage : null;

  if (currentId === null) {
    return { action: 'unknown', current: null, usedPct: null, reason: 'current account not resolvable from CLAUDE_CONFIG_DIR / registry' };
  }
  if (usedPct === null) {
    // A stale or absent 5h reading is NOT zero — rotating (or declaring idle) on unknown data is
    // exactly the blind decision this must avoid. Wait for a fresh capture from the tap/keeper.
    return { action: 'unknown', current: currentId, usedPct: null, reason: `no fresh 5h capture for ${currentId} — not deciding` };
  }
  if (usedPct < thresholds.softPct) {
    return { action: 'idle', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (< ${thresholds.softPct}% soft)` };
  }
  if (usedPct < thresholds.hardPct) {
    return { action: 'watch', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% (>= ${thresholds.softPct}% soft, < ${thresholds.hardPct}% hard)` };
  }

  const pick = pickClaudeAccount(caps, accounts, { routeAwayAtPct: thresholds.hardPct });
  if (!pick) {
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% and no account is selectable` };
  }
  if (pick.account.id === currentId) {
    // The best account IS the current one — every alternative is worse or unusable. Rotating would
    // land us back where we are (or somewhere equally dead), so the operator must decide.
    return { action: 'exhausted', current: currentId, usedPct, reason: `${currentId} at ${usedPct.toFixed(0)}% is still the best account — all Claude accounts are near the cap` };
  }
  return {
    action: 'rotate', current: currentId, usedPct, target: pick.account,
    targetEnv: { env: pick.env, envUnset: pick.envUnset },
    reason: `rotate ${currentId} (${usedPct.toFixed(0)}%) → ${pick.account.id} (${pick.reason})`,
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
  const caps = readLimitsMirror(opts.usageDir, Math.floor(opts.nowMs / 1000))?.['claude'];
  return decideRotation(caps, accounts, env, opts.thresholds);
}
