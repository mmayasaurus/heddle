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
import { readFileSync } from 'node:fs';
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
export interface SpreadPolicyOptions {
  /** Registry file to read when `accounts` is not supplied. Defaults to $HEDDLE_ACCOUNTS or ~/.heddle/accounts.json. */
  registryPath?: string;
  /**
   * Pre-loaded accounts to use INSTEAD of reading `registryPath`. spreadStep passes the registry it has
   * already read + validated, so the registry is read exactly once per wizard run — no second read to
   * race the first (a corrupt registry is caught by that single read, in the step). Standalone callers
   * (and this module's own tests) omit it and let the function read `registryPath` itself.
   */
  accounts?: Account[];
}
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
  let claudeAccounts: Account[];
  if (opts.accounts) {
    // Caller supplied the accounts (spreadStep, which read + validated the registry itself) — use them
    // directly so the registry is read only once per run.
    claudeAccounts = opts.accounts.filter((a) => a.provider === 'claude');
  } else {
    const registryPath = opts.registryPath ?? process.env.HEDDLE_ACCOUNTS ?? join(homedir(), '.heddle', 'accounts.json');
    try {
      claudeAccounts = loadAccountRegistry(registryPath).accounts.filter((a) => a.provider === 'claude');
    } catch (error) {
      // loadAccountRegistry throws a clear message on a corrupt/invalid registry. This step is optional,
      // so surface it and skip rather than aborting the whole wizard mid-run.
      deps.report?.(`⚠ Could not read the account registry (${registryPath}): ${error instanceof Error ? error.message : String(error)}. Skipping the spread policy — fix the registry and re-run.`);
      return noop();
    }
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
// A WizardStep adapter over runSpreadPolicy that ALSO persists the captured policy, so `heddle setup`
// can run it inline (accounts → model-economy → spread → …) and the finish screen reports its outcome.
// The step owns its own write via the HED-564 seam (policyPath + atomicWriteFile — which mkdir -p's
// ~/.heddle/policy itself). Kept in this module (not setup.ts) so the step stays on a disjoint file per
// the HED-564 wire-in protocol; setup.ts adds one buildSteps line to register it. Its fail-vs-skip and
// merge-preserving-write discipline deliberately mirror the meters step (src/wizard/meters-step.ts).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read + validate an existing spread policy so a re-run MERGES into it rather than replacing the whole
 * file (WizardStep contract: run() must be idempotent + merge-preserving). Returns {} when the file is
 * absent (a first run); throws on a read/parse error or a non-object root so the caller can FAIL loudly
 * rather than clobber a corrupt policy — the ENOENT-vs-error discipline metersStep uses. The caller
 * overwrites only the spread-owned fields, so unknown top-level fields a future consumer/migration adds
 * are preserved; there is no per-field shape to walk (unlike the per-account map metersStep validates).
 */
function readPriorSpreadPolicy(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('spread policy is not a JSON object');
  return parsed;
}

/**
 * The spread/rotation step (HED-474 core, wrapped for HED-579). Prompts for the participating Claude
 * accounts and a per-account concurrent cap, previews the exact even split (all via runSpreadPolicy),
 * then MERGE-PRESERVINGLY writes the resulting policy to `<homeDir>/.heddle/policy/spread.json`.
 *
 * Status: 'done' on a saved policy; 'skipped' for a genuine no-op (no Claude accounts, none selected, or
 * the operator declined — runSpreadPolicy reports which); 'failed' for a corrupt account registry or a
 * corrupt/unwritable existing policy, so `heddle setup` forces repair instead of masquerading as done.
 * Under `heddle setup --dry-run` it prompts for NOTHING and writes NOTHING — reports what a real run
 * would do and returns 'skipped' (spread WRITES a file so it is not read-only; 'skipped' is the correct
 * dry-run status per the contract, not 'done'). Fail/skip/dry-run semantics mirror the meters step.
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
    const registryPath = process.env.HEDDLE_ACCOUNTS ?? join(ctx.homeDir, '.heddle', 'accounts.json');
    // Read + validate the registry ONCE here and hand the accounts to runSpreadPolicy so it does not
    // re-read (a single read, no time-of-check/time-of-use gap). loadAccountRegistry returns an EMPTY
    // registry for a MISSING file — a genuine no-op runSpreadPolicy reports as 'skipped' below — and
    // throws ONLY for malformed/invalid content, so we FAIL only on real corruption, forcing repair
    // rather than a silent skip that lets `heddle setup` finish "all done or skipped".
    let registry: ReturnType<typeof loadAccountRegistry>;
    try {
      registry = loadAccountRegistry(registryPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.report(`✗ spread: ${message}`);
      return { id: 'spread', status: 'failed', summary: `could not read the account registry: ${message}` };
    }
    const { policy } = await runSpreadPolicy({ accounts: registry.accounts }, { prompter: io.prompter, report: io.report });
    if (policy.accounts.length === 0) {
      // Genuine no-op — runSpreadPolicy already reported which (no Claude accounts, none selected, or the
      // operator declined). A corrupt registry was already caught above as 'failed'.
      return { id: 'spread', status: 'skipped', summary: 'spread — no policy saved' };
    }
    // Merge-preserving write (WizardStep contract): preserve any unknown top-level fields a future
    // consumer/migration added to spread.json and overwrite only the spread-owned fields; FAIL on a
    // malformed existing file rather than clobber it.
    const policyFile = policyPath(ctx.homeDir, 'spread');
    let prior: Record<string, unknown>;
    try {
      prior = readPriorSpreadPolicy(policyFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'spread', status: 'failed', summary: `existing spread policy at ${policyFile} is corrupt or unreadable: ${message}` };
    }
    try {
      atomicWriteFile(policyFile, `${JSON.stringify({ ...prior, ...policy }, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'spread', status: 'failed', summary: `could not write the spread policy at ${policyFile}: ${message}` };
    }
    return {
      id: 'spread',
      status: 'done',
      summary: `even-spread · ${policy.accounts.length} Claude account(s) · cap ${policy.capPerAccount}/account`,
      detail: `accounts: ${policy.accounts.join(', ')}`,
    };
  },
};
