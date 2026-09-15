import { existsSync, readFileSync } from 'node:fs';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';
import { resolvePreset, type SafetyPreset } from './presets.js';
import { runHooksChoose, type HookRuleSelection } from './hooks-choose.js';
import { atomicWriteFile, policyPath } from './persist.js';

const presetChoices = ['minimal', 'standard', 'strict'] as const satisfies readonly SafetyPreset[];

function isSafetyPreset(choice: string): choice is SafetyPreset {
  return (presetChoices as readonly string[]).includes(choice);
}

/**
 * Read the existing rules policy so a rerun is merge-preserving (the WizardStep contract in step.ts
 * requires each step-owned write to be idempotent + merge-preserving): unknown top-level fields a newer
 * consumer or migration wrote are kept, and only this step's OWNED fields (`schemaVersion`, `rules`) are
 * replaced by the caller. An absent file returns {} (a fresh write). Anything present that is not a v1
 * JSON object — unparseable, a non-object, or a `schemaVersion` this writer does not own — THROWS rather
 * than silently clobbering it; the orchestrator records the step 'failed' (fail-soft) and the operator
 * can fix the file and re-run. Exported for direct unit testing of the fail/preserve branches.
 */
export function loadExistingRulesPolicy(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`refusing to overwrite ${path}: it is not valid JSON (${detail}). Fix or remove it, then re-run.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const found = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed;
    throw new Error(`refusing to overwrite ${path}: expected a JSON object, found ${found}. Fix or remove it, then re-run.`);
  }
  const existing = parsed as Record<string, unknown>;
  if (existing.schemaVersion !== undefined && existing.schemaVersion !== 1) {
    throw new Error(`refusing to overwrite ${path}: it declares schemaVersion ${JSON.stringify(existing.schemaVersion)}, which this version of heddle setup does not understand (expected 1). Upgrade heddle or migrate the file first.`);
  }
  return existing;
}

export function existingRuleSelection(existing: Record<string, unknown>): HookRuleSelection[] | undefined {
  const raw = existing.rules;
  if (!Array.isArray(raw)) return undefined;
  const valid = raw.filter((entry): entry is HookRuleSelection =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as HookRuleSelection).id === 'string'
    && typeof (entry as HookRuleSelection).enforce === 'boolean');
  return valid.length ? valid : undefined;
}

export function rulesStep(catalogRoot: string): WizardStep {
  return {
    id: 'rules',
    title: 'Safety rules',
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      const policyFile = policyPath(ctx.homeDir, 'rules');
      if (ctx.dryRun) {
        io.report(`dry-run — rules: a real run would prompt for a preset, fine-tune the hooks chooser, and write ${policyFile}; nothing was prompted or written.`);
        return {
          id: 'rules',
          status: 'skipped',
          summary: 'dry-run — rules prompting and write skipped',
        };
      }

      // Fail fast: read + validate any existing policy BEFORE prompting, so a malformed or
      // unknown-version file aborts the step immediately rather than after the operator has picked a
      // preset and fine-tuned it (codacy review). The same object is reused for the merge-preserving
      // write below.
      const existing = loadExistingRulesPolicy(policyFile);

      const choice = await io.prompter.select('Safety preset', ['minimal', 'standard', 'strict', 'custom (choose each rule)']);
      let selection: HookRuleSelection[];
      if (isSafetyPreset(choice)) {
        const presetDefaults = resolvePreset(choice, catalogRoot);
        io.report(`${choice} preset: ${presetDefaults.map((rule) => rule.id).join(', ')}`);
        const asIs = await io.prompter.confirm(`Accept the ${choice} preset as-is (${presetDefaults.length} rule(s))?`, true);
        selection = asIs
          ? presetDefaults
          : (await runHooksChoose({ catalogRoot, defaults: presetDefaults }, { prompter: io.prompter, report: io.report })).selected;
      } else {
        const prior = existingRuleSelection(existing);
        if (prior) io.report(`Pre-filling the chooser from your existing policy (${prior.length} rule(s)); adjust as needed.`);
        selection = (await runHooksChoose({ catalogRoot, defaults: prior }, { prompter: io.prompter, report: io.report })).selected;
      }

      if (!await io.prompter.confirm(`Save these rules to ${policyFile}?`, true)) {
        io.report('Rules policy not saved.');
        return { id: 'rules', status: 'skipped', summary: 'rules: not saved' };
      }

      // Merge-preserving write (WizardStep contract): keep any unknown top-level fields a newer
      // consumer/migration wrote, replace only this step's owned fields (schemaVersion, rules). The
      // existing policy was already read + validated at the top of run().
      atomicWriteFile(policyFile, JSON.stringify({ ...existing, schemaVersion: 1, rules: selection }, null, 2) + '\n');
      const enforced = selection.filter((rule) => rule.enforce).length;
      return {
        id: 'rules',
        status: 'done',
        summary: `rules: ${choice} → ${selection.length} rule(s)`
          + (enforced > 0 ? ` (${enforced} enforced)` : '')
          + (selection.length ? `: ${selection.map((rule) => rule.id).join(', ')}` : ''),
      };
    },
  };
}
