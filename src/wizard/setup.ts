// HED-564: the top-level `heddle setup` orchestrator. It composes the self-contained wizard steps
// into ONE ordered walkthrough and is the SINGLE writer of step composition — step modules stay on
// disjoint files, never import each other, and never edit this file. Owners land their step module
// (model-economy HED-473, spread HED-474, meters HED-475, rules HED-544, doctor HED-476) and it is
// wired here as a one-line addition to `buildSteps`; today only the accounts step is wired.
import type { WizardContext, WizardIO, WizardStep, WizardStepResult, WizardStepStatus } from './step.js';
import type { CliRunner } from './cli-runner.js';
import { runAccountsAdd, type AccountsAddSummary } from './accounts-add.js';
import { doctorStep } from './doctor.js';

/**
 * Everything a step needs EXCEPT `results`: the orchestrator owns the results map and fills it as it
 * runs (so a step reads priors through the read-only `ctx.results` view). Callers build one of these;
 * `runSetup` turns it into the full `WizardContext`.
 */
export type SetupContext = Omit<WizardContext, 'results'>;

/** Construction deps for the built-in step set — each step closes over only the deps it alone needs. */
export interface SetupDeps {
  /** Native-CLI runner the accounts step uses for vendor logins (injected so tests can fake it). */
  runner: CliRunner;
  // The rules step (HED-544) will add a `catalogRoot` dep here when it wires in — omitted until then
  // so nothing computes a value no step reads.
}

/**
 * The accounts step — an adapter over the existing `runAccountsAdd` flow, which writes the account
 * registry (`~/.heddle/accounts.json`) itself. A factory closing over the `CliRunner`, since no other
 * step needs a runner and `WizardContext` stays lean. Under --dry-run it prompts for nothing and logs
 * in to nothing: it reports what a real run would do and returns 'skipped'.
 */
/**
 * Map a `runAccountsAdd` summary to a step outcome. ANY failed account → 'failed' (so `heddle setup`
 * exits non-zero and the operator sees setup did not fully succeed — a login/verification failure must
 * NOT masquerade as success); else anything added → 'done'; else the operator declined every account →
 * 'skipped'. Pure, so the exit-code semantics are unit-tested independent of a real login.
 */
export function summarizeAccounts(result: AccountsAddSummary): { status: WizardStepStatus; summary: string; detail?: string } {
  const status: WizardStepStatus = result.failed.length ? 'failed' : result.added.length ? 'done' : 'skipped';
  const counts = [
    `${result.added.length} added`,
    ...(result.failed.length ? [`${result.failed.length} failed`] : []),
    ...(result.skipped.length ? [`${result.skipped.length} declined`] : []),
  ].join(', ');
  const detail = [
    result.added.length ? `added: ${result.added.join(', ')}` : undefined,
    result.failed.length ? `failed: ${result.failed.join(', ')}` : undefined,
    result.skipped.length ? `declined: ${result.skipped.join(', ')}` : undefined,
  ].filter(Boolean).join('\n');
  return { status, summary: `accounts: ${counts}`, ...(detail ? { detail } : {}) };
}

export function accountsStep(runner: CliRunner): WizardStep {
  return {
    id: 'accounts',
    title: 'Accounts',
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (ctx.dryRun) {
        io.report('dry-run — accounts: a real run would prompt for Claude/Codex/Cursor logins and write the account registry; nothing was prompted or written.');
        return {
          id: 'accounts',
          status: 'skipped',
          summary: 'dry-run — accounts prompting and login skipped (no registry write)',
        };
      }
      // Pass homeDir (not registryPath) so the registry AND the per-account credential dirs share one
      // root under --home — accounts-add derives both from it (no split install).
      const result = await runAccountsAdd(
        { homeDir: ctx.homeDir },
        { prompter: io.prompter, runner, now: ctx.now, report: io.report },
      );
      return { id: 'accounts', ...summarizeAccounts(result) };
    },
  };
}

/**
 * Wrap a step so it does NOT run under --dry-run: it reports what a real run WOULD do and returns
 * 'skipped'. Only the doctor finish-gate needs this. In a preview every write-step above it skips, so
 * the machine stays unchanged — running the real `heddle doctor` probe would then report failures the
 * preview never caused (on a fresh box that alone would make `heddle setup --dry-run` exit non-zero,
 * turning a preview into a false alarm). The doctor MODULE always runs by design — correct for
 * `heddle doctor` standalone and for the real walkthrough (see doctor.ts); whether the walkthrough
 * runs its finish gate in PREVIEW mode is a composition choice, so it lives here, not in doctor.ts.
 * `would` is the preview line shown in place of the real run. Exported so the pass-through (a real run
 * delegates to the wrapped step untouched) is unit-tested directly.
 */
export function dryRunGate(step: WizardStep, would: string): WizardStep {
  return {
    ...step,
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (ctx.dryRun) {
        io.report(would);
        return {
          id: step.id,
          status: 'skipped',
          summary: `dry-run — ${step.id} did not run (a preview makes no changes, so there is nothing to verify)`,
        };
      }
      return step.run(ctx, io);
    },
  };
}

/**
 * Build the ordered built-in step set. Each new step module is added here as one line as its owner
 * lands it, in walkthrough order: accounts → model-economy → spread → meters → rules → doctor (last).
 * Doctor is the read-only finish gate; it is wrapped in `dryRunGate` so a --dry-run preview skips it
 * (see that helper). Every other step self-handles dry-run inside its own module.
 */
export function buildSteps(deps: SetupDeps): WizardStep[] {
  return [
    accountsStep(deps.runner),
    // model-economy (HED-473), spread (HED-474), meters (HED-475), rules (HED-544) wire in here as a
    // one-line addition as their owners land the modules.
    // doctor (HED-476) is ALWAYS last — the read-only finish gate that verifies setup end-to-end.
    dryRunGate(
      doctorStep,
      'dry-run — doctor: a real setup would run `heddle doctor` to verify the configured environment end-to-end; nothing was verified.',
    ),
  ];
}

/**
 * Resolve which steps run from the `--only` / `--skip` selectors. Pure so the CLI stays thin and the
 * validation is unit-tested: `--only` and `--skip` are mutually exclusive, and every named id must
 * exist (a typo like `--only acounts` must fail loudly, never silently run nothing). Order preserved.
 */
export function selectSteps(steps: WizardStep[], only?: readonly string[], skip?: readonly string[]): WizardStep[] {
  if (only && skip) throw new Error('heddle setup: pass --only or --skip, not both');
  const known = new Set(steps.map((step) => step.id));
  for (const id of [...(only ?? []), ...(skip ?? [])]) {
    if (!known.has(id)) throw new Error(`heddle setup: unknown step id '${id}' — known ids: ${[...known].join(', ')}`);
  }
  if (only) return steps.filter((step) => only.includes(step.id));
  if (skip) return steps.filter((step) => !skip.includes(step.id));
  return steps;
}

/**
 * Run an ordered set of steps as ONE walkthrough. The orchestrator owns the results map — a step
 * reads priors through the read-only `ctx.results` view but never writes it — and is FAIL-SOFT: a
 * step that throws is recorded 'failed' and the walkthrough continues, so the operator can re-run
 * just that step with `heddle setup --only <id>`. Returns every step's result in run order for the
 * caller's exit code and machine output.
 */
export async function runSetup(base: SetupContext, io: WizardIO, steps: WizardStep[]): Promise<WizardStepResult[]> {
  // Composition guard: step ids key the results map, so a duplicate id would silently drop one
  // EXECUTED step from the finish screen and the returned machine output (and its exit-code signal).
  // buildSteps is the single writer, but each step owner appends a line — so catch a collision loudly
  // and early (a composition bug), before any step runs. Mirrors selectSteps' unknown-id guard.
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`heddle setup: duplicate step id '${step.id}' — each step must have a unique id (buildSteps composition bug)`);
    }
    seen.add(step.id);
  }

  // The single mutable results map; the context exposes it only as a ReadonlyMap to steps.
  const results = new Map<string, Readonly<WizardStepResult>>();
  const ctx: WizardContext = { ...base, results };

  for (const step of steps) {
    io.report(`\n== ${step.title} ==`);
    try {
      // applies() is evaluated INSIDE the try so a throwing predicate is recorded 'failed' and the
      // walkthrough continues (fail-soft) — it must never escape to abort later steps and skip the
      // finish screen (a step's applies() may probe the filesystem or environment and throw).
      if (step.applies && !step.applies(ctx)) {
        results.set(step.id, { id: step.id, status: 'skipped', summary: 'not applicable in this context' });
        io.report('  – skipped (not applicable in this context)');
        continue;
      }
      results.set(step.id, await step.run(ctx, io));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.set(step.id, { id: step.id, status: 'failed', summary: `failed: ${message}` });
      io.report(`  ✗ ${step.id} failed: ${message}  (re-run with: heddle setup --only ${step.id})`);
    }
  }

  const ordered = [...results.values()];
  // Finish screen — always echo every step's outcome so "setup complete" is a proven claim.
  io.report('\n== Setup complete ==');
  for (const result of ordered) {
    const mark = result.status === 'done' ? '✓' : result.status === 'skipped' ? '–' : '✗';
    io.report(`  ${mark} ${result.id}: ${result.summary}`);
  }
  const failed = ordered.filter((result) => result.status === 'failed').length;
  io.report(failed
    ? `\n${failed} step${failed === 1 ? '' : 's'} failed — fix, then re-run: heddle setup --only <id>.`
    : '\nAll steps done or skipped. Run `heddle doctor` to verify the setup end-to-end.');
  return ordered;
}
