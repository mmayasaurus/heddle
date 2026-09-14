// HED-564: the top-level `heddle setup` orchestrator. It composes the self-contained wizard steps
// into ONE ordered walkthrough and is the SINGLE writer of step composition — step modules stay on
// disjoint files, never import each other, and never edit this file. Owners land their step module
// (model-economy HED-473, spread HED-474, meters HED-475, rules HED-544, doctor HED-476) and it is
// wired here as a one-line addition to `buildSteps`; today only the accounts step is wired.
import { join } from 'node:path';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';
import type { CliRunner } from './cli-runner.js';
import { runAccountsAdd } from './accounts-add.js';

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
      const summary = await runAccountsAdd(
        { registryPath: join(ctx.homeDir, '.heddle', 'accounts.json') },
        { prompter: io.prompter, runner, now: ctx.now, report: io.report },
      );
      const detail = [
        summary.added.length ? `added: ${summary.added.join(', ')}` : undefined,
        summary.failed.length ? `failed: ${summary.failed.join(', ')}` : undefined,
        summary.skipped.length ? `declined: ${summary.skipped.join(', ')}` : undefined,
      ].filter(Boolean).join('\n');
      return {
        id: 'accounts',
        // 'done' if anything was added; otherwise the operator declined every account → 'skipped'.
        status: summary.added.length ? 'done' : 'skipped',
        summary: `${summary.added.length} account${summary.added.length === 1 ? '' : 's'} added` +
          (summary.failed.length ? `, ${summary.failed.length} failed` : '') +
          (summary.skipped.length ? `, ${summary.skipped.length} declined` : ''),
        ...(detail ? { detail } : {}),
      };
    },
  };
}

/**
 * Build the ordered built-in step set. Each new step module is added here as one line as its owner
 * lands it, in walkthrough order: accounts → model-economy → spread → meters → rules → doctor (last).
 */
export function buildSteps(deps: SetupDeps): WizardStep[] {
  return [
    accountsStep(deps.runner),
    // model-economy (HED-473), spread (HED-474), meters (HED-475), rules (HED-544),
    // doctor (HED-476 — always last) wire in here as their owners land the modules.
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
  // The single mutable results map; the context exposes it only as a ReadonlyMap to steps.
  const results = new Map<string, Readonly<WizardStepResult>>();
  const ctx: WizardContext = { ...base, results };

  for (const step of steps) {
    if (step.applies && !step.applies(ctx)) {
      results.set(step.id, { id: step.id, status: 'skipped', summary: 'not applicable in this context' });
      io.report(`\n== ${step.title} ==  (skipped — not applicable)`);
      continue;
    }
    io.report(`\n== ${step.title} ==`);
    try {
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
