/**
 * Wizard step: capture the user's Claude spread/rotation policy (HED-474).
 *
 * This module is deliberately thin. The even-spread ALGORITHM already exists at runtime:
 * `pickClaudeAccountsBatch` (`src/account-pick.ts`) does deterministic weighted-LPT placement. The
 * per-account concurrent CAP captured here is genuinely NEW — it is NOT `lanes.yaml`
 * `floors.claude.residency_max` (that is a low-headroom-ONLY degradation cap, firing only when an
 * account's headroom <= `residency_cap_below_pct`). This step only CAPTURES the user's policy
 * (participating accounts + an unconditional per-account cap) and PREVIEWS the exact split; it wires
 * nothing and persists nothing (INERT at merge). The returned policy's consumer-wiring (HED-446
 * picker, HED-452 rotation) is deferred.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadAccountRegistry } from '../accounts.js';
import type { Prompter } from './prompt.js';

export interface SpreadPolicy {
  strategy: 'even-spread';   // discriminant; only strategy today
  provider: 'claude';        // both consumers (HED-446 picker, HED-452 rotation) are Claude-scoped
  accounts: string[];        // participating Claude account ids, in registry order
  capPerAccount: number;     // UNCONDITIONAL per-account concurrent-session cap (NEW; not residency_max)
}
export interface SpreadPolicyResult { policy: SpreadPolicy; }
export interface SpreadPolicyOptions { registryPath?: string; }
export interface SpreadPolicyDeps { prompter: Prompter; report?: (line: string) => void; }

/** PREVIEW ONLY — the idealized exact-split even spread the policy TARGETS, shown to the user at wizard
 *  time (no live usage caps exist yet). Runtime placement is pickClaudeAccountsBatch (weighted-LPT,
 *  src/account-pick.ts) and this does NOT replace it. First `sessions % accounts` accounts get the
 *  ceiling, the rest the floor, so max−min ≤ 1 — e.g. evenSplit(7, 4) → [2, 2, 2, 1]. */
export function evenSplit(sessions: number, accounts: number): number[] {
  if (!Number.isInteger(accounts) || accounts <= 0) throw new Error('evenSplit: accounts must be a positive integer');
  if (!Number.isInteger(sessions) || sessions < 0) throw new Error('evenSplit: sessions must be a non-negative integer');
  const base = Math.floor(sessions / accounts);
  const remainder = sessions % accounts;
  return Array.from({ length: accounts }, (_, i) => base + (i < remainder ? 1 : 0));
}

function parsePositiveInt(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function noop(): SpreadPolicyResult {
  return { policy: { strategy: 'even-spread', provider: 'claude', accounts: [], capPerAccount: 0 } };
}

export async function runSpreadPolicy(opts: SpreadPolicyOptions, deps: SpreadPolicyDeps): Promise<SpreadPolicyResult> {
  const registryPath = opts.registryPath ?? process.env.HEDDLE_ACCOUNTS ?? join(homedir(), '.heddle', 'accounts.json');
  const claudeAccounts = loadAccountRegistry(registryPath).accounts.filter((a) => a.provider === 'claude');
  if (claudeAccounts.length === 0) {
    deps.report?.('No Claude accounts registered — add them with accounts-add first; skipping spread policy.');
    return noop();
  }
  const participating: string[] = [];
  for (const a of claudeAccounts) {
    if (await deps.prompter.confirm(`Include ${a.id} in the even spread?`, a.loggedIn !== false)) participating.push(a.id);
  }
  if (participating.length === 0) {
    deps.report?.('No accounts selected — skipping spread policy.');
    return noop();
  }
  const sessions = parsePositiveInt(
    await deps.prompter.text('How many concurrent sessions do you expect to run across these accounts?', String(participating.length)),
    participating.length,
  );
  const split = evenSplit(sessions, participating.length);
  deps.report?.(`Even spread: ${sessions} session(s) across ${participating.length} account(s) → ${split.join('/')} (${participating.map((id, i) => `${id}:${split[i]}`).join(', ')}).`);
  const ceiling = Math.max(...split);
  const capPerAccount = parsePositiveInt(await deps.prompter.text('Max concurrent sessions per account (cap)?', String(ceiling)), ceiling);
  if (sessions > participating.length * capPerAccount) {
    deps.report?.(`⚠ ${sessions} sessions cannot all fit under a cap of ${capPerAccount} across ${participating.length} account(s) (max ${participating.length * capPerAccount}); excess sessions stay queued until an account frees up.`);
  }
  if (!await deps.prompter.confirm('Save this spread/rotation policy?', true)) {
    deps.report?.('Spread policy not saved.');
    return noop();
  }
  return { policy: { strategy: 'even-spread', provider: 'claude', accounts: participating, capPerAccount } };
}
