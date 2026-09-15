import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';
import { resolvePreset, type SafetyPreset } from './presets.js';
import { runHooksChoose, type HookRuleSelection } from './hooks-choose.js';
import { atomicWriteFile, policyPath } from './persist.js';

const presetChoices = ['minimal', 'standard', 'strict'] as const satisfies readonly SafetyPreset[];

function isSafetyPreset(choice: string): choice is SafetyPreset {
  return (presetChoices as readonly string[]).includes(choice);
}

export function rulesStep(catalogRoot: string): WizardStep {
  return {
    id: 'rules',
    title: 'Safety rules',
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (ctx.dryRun) {
        io.report('dry-run — rules: a real run would prompt for a preset, fine-tune the hooks chooser, and write ~/.heddle/policy/rules.json; nothing was prompted or written.');
        return {
          id: 'rules',
          status: 'skipped',
          summary: 'dry-run — rules prompting and write skipped',
        };
      }

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
        selection = (await runHooksChoose({ catalogRoot }, { prompter: io.prompter, report: io.report })).selected;
      }

      if (!await io.prompter.confirm('Save these rules to ~/.heddle/policy/rules.json?', true)) {
        io.report('Rules policy not saved.');
        return { id: 'rules', status: 'skipped', summary: 'rules: not saved' };
      }

      atomicWriteFile(policyPath(ctx.homeDir, 'rules'), JSON.stringify(selection, null, 2) + '\n');
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
