/**
 * Wizard step: capture the user's Claude spread/rotation policy (HED-474).
 *
 * This module is deliberately thin. The even-spread ALGORITHM already exists at runtime:
 * `pickClaudeAccountsBatch` (`src/account-pick.ts`) does deterministic weighted-LPT placement. The
 * per-account concurrent CAP captured here is genuinely NEW — it is NOT `lanes.yaml`
 * `floors.claude.residency_max` (that is a low-headroom-ONLY degradation cap, firing only when an
 * account's headroom <= `residency_cap_below_pct`). `runSpreadPolicy` only CAPTURES the user's policy
 * (participating accounts + an unconditional per-account cap) and PREVIEWS the exact split — it persists
 * nothing. `spreadStep` (HED-579, at the foot of this file) wraps it as a WizardStep and DOES persist,
 * writing `<home>/.heddle/policy/spread.json`. The module is still INERT at merge: `spreadStep` runs only
 * once Y adds its one-line `buildSteps` registration (HED-564 protocol). The policy's consumer-wiring
 * (HED-446 picker, HED-452 rotation) is deferred.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadAccountRegistry, type Account } from '../accounts.js';
import type { Prompter } from './prompt.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';
import { atomicWriteFile, policyPath } from './persist.js';

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

// Strict: only a bare positive decimal integer is accepted. Number.parseInt would silently truncate
// '2.5' -> 2 and '7abc' -> 7, which would save a policy that differs from what the operator typed
// (qodo review). A blank / non-numeric / out-of-safe-range entry falls back to the caller's default.
function parsePositiveInt(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

function noop(): SpreadPolicyResult {
  return { policy: { strategy: 'even-spread', provider: 'claude', accounts: [], capPerAccount: 0 } };
}

export async function runSpreadPolicy(opts: SpreadPolicyOptions, deps: SpreadPolicyDeps): Promise<SpreadPolicyResult> {
  const registryPath = opts.registryPath ?? process.env.HEDDLE_ACCOUNTS ?? join(homedir(), '.heddle', 'accounts.json');
  let claudeAccounts: Account[];
  try {
    claudeAccounts = loadAccountRegistry(registryPath).accounts.filter((a) => a.provider === 'claude');
  } catch (error) {
    // loadAccountRegistry throws a clear message on a corrupt/invalid registry. This step is optional,
    // so surface it and skip rather than aborting the whole wizard mid-run.
    deps.report?.(`⚠ Could not read the account registry (${registryPath}): ${error instanceof Error ? error.message : String(error)}. Skipping the spread policy — fix the registry and re-run.`);
    return noop();
  }
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
  // ceil(sessions / k) is the exact even-spread ceiling (=== Math.max(...split)), computed directly so
  // it never depends on a non-empty spread array. sessions >= 1 and participating.length >= 1 here.
  const ceiling = Math.ceil(sessions / participating.length);
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

// ── HED-579: the spread policy as a wizard step ──────────────────────────────────────────────────
// A thin WizardStep adapter over runSpreadPolicy that ALSO persists the captured policy, so `heddle
// setup` can run it inline (accounts → model-economy → spread → …) and the finish screen reports its
// outcome. The step owns its own write via the HED-564 seam (policyPath + atomicWriteFile — which
// mkdir -p's ~/.heddle/policy itself). Kept in this module (not setup.ts) so the step stays on a
// disjoint file per the HED-564 wire-in protocol; setup.ts adds one buildSteps line to register it.

/**
 * The spread/rotation step (HED-474 core, wrapped for HED-579). Prompts for the participating Claude
 * accounts and a per-account concurrent cap, previews the exact even split (all via runSpreadPolicy),
 * then writes the resulting policy to `<homeDir>/.heddle/policy/spread.json`.
 *
 * Under `heddle setup --dry-run` it prompts for NOTHING and writes NOTHING — it reports what a real run
 * would do and returns 'skipped'. (Spread is NOT read-only, so 'skipped' is the correct dry-run status
 * per the WizardStep contract, not 'done'; this mirrors the accounts step.)
 */
export const spreadStep: WizardStep = {
  id: 'spread',
  title: 'Spread / rotation policy',
  async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
    if (ctx.dryRun) {
      io.report(`dry-run — spread: a real run would prompt for the participating Claude accounts and a per-account concurrent cap, preview the even split, and write the policy to ${policyPath(ctx.homeDir, 'spread')}; nothing was prompted or written.`);
      return { id: 'spread', status: 'skipped', summary: 'dry-run — spread prompting and policy write skipped (no file written)' };
    }
    // Mirror runAccountsAdd's registry-path precedence (explicit HEDDLE_ACCOUNTS env, else the
    // home-derived default) so BOTH steps read/write the SAME registry under `heddle setup --home <dir>`.
    // Passing it explicitly also stops runSpreadPolicy from falling back to the process user's real
    // homedir() when ctx.homeDir differs — the split-install trap accounts-add.ts warns about.
    const registryPath = process.env.HEDDLE_ACCOUNTS ?? join(ctx.homeDir, '.heddle', 'accounts.json');
    const { policy } = await runSpreadPolicy({ registryPath }, { prompter: io.prompter, report: io.report });
    if (policy.accounts.length === 0) {
      // runSpreadPolicy already reported WHY it produced no policy (no Claude accounts, none selected,
      // the operator declined to save, or a corrupt registry) — nothing to persist. NOTE (HED-579): the
      // core returns this same empty policy for all four cases, so a corrupt registry also reports
      // 'skipped' rather than 'failed'. Left as-is: the core already emits the ⚠ registry-read error and
      // `heddle doctor` (the last step) re-checks the registry, and distinguishing would need a reason
      // field on SpreadPolicyResult that would break the core's result-equality tests. Revisit if doctor
      // ever cannot surface the corrupt-registry case.
      return { id: 'spread', status: 'skipped', summary: 'spread — no policy saved' };
    }
    atomicWriteFile(policyPath(ctx.homeDir, 'spread'), `${JSON.stringify(policy, null, 2)}\n`);
    return {
      id: 'spread',
      status: 'done',
      summary: `even-spread · ${policy.accounts.length} Claude account(s) · cap ${policy.capPerAccount}/account`,
      detail: `accounts: ${policy.accounts.join(', ')}`,
    };
  },
};
