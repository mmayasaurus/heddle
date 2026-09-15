import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules } from '../rules/load.js';
import { previewCase } from '../rules/preview.js';
import type { HookPayload } from '../rules/evaluate.js';
import type { Rule } from '../rules/schema.js';
import type { Prompter } from './prompt.js';

export interface HookRuleSelection { id: string; enforce: boolean; }
export interface HooksChooseResult { selected: HookRuleSelection[]; }
export interface HooksChooseDeps { prompter: Prompter; report?: (msg: string) => void; }
export interface HooksChooseOptions { catalogRoot: string; defaults?: HookRuleSelection[]; }

type PreviewFixtureCase = { name: string; payload: HookPayload };

function fixtureCases(path: string): PreviewFixtureCase[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
      if (!line.trim() || line.trim().startsWith('#')) return [];
      try {
        const item = JSON.parse(line) as Partial<PreviewFixtureCase>;
        // Require a string hook_event_name: previewCase → fixtureEvalContext throws without one,
        // which would abort the whole chooser on a single malformed catalog fixture (codeant #152).
        return typeof item.name === 'string' && item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
          && typeof (item.payload as HookPayload).hook_event_name === 'string'
          ? [{ name: item.name, payload: item.payload }]
          : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function defaultRule(rule: Rule): Rule {
  return rule.action === 'block' ? { ...rule, enforce: false } : rule;
}

function reportPreview(rule: Rule, cases: PreviewFixtureCase[], report?: (msg: string) => void, label = ''): void {
  if (!cases.length) { report?.(`${rule.id}: no fixture cases available for preview`); return; }
  for (const item of cases) {
    const preview = previewCase(rule, item.payload);
    report?.(`${rule.id} ${item.name}: ${preview.matched ? `${label}WOULD MATCH → ${preview.outcome.toUpperCase()}` : 'would not match'}`);
  }
}

export async function runHooksChoose(opts: HooksChooseOptions, deps: HooksChooseDeps): Promise<HooksChooseResult> {
  const rules = loadRules(opts.catalogRoot).sort((left, right) => left.id.localeCompare(right.id));
  if (!rules.length) {
    deps.report?.('no hook-rules available');
    return { selected: [] };
  }
  const selected: HookRuleSelection[] = [];
  for (const sourceRule of rules) {
    const rule = defaultRule(sourceRule);
    const oneLine = rule.message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
    deps.report?.(`${rule.id} — ${rule.action} ${rule.event}: ${oneLine}`);
    const cases = fixtureCases(join(opts.catalogRoot, 'tests', `${rule.id}.jsonl`));
    reportPreview(rule, cases, deps.report);
    const includeDefault = (opts.defaults ?? []).some((defaultSelection) => defaultSelection.id === rule.id);
    if (!await deps.prompter.confirm(`include ${rule.id}?`, includeDefault)) continue;
    let enforce = rule.enforce;
    if (rule.action === 'block') {
      const enforced = { ...rule, enforce: true };
      reportPreview(enforced, cases, deps.report, 'ENFORCED ');
      const enforceDefault = opts.defaults?.find((defaultSelection) => defaultSelection.id === rule.id)?.enforce ?? false;
      enforce = await deps.prompter.confirm(`enable ENFORCEMENT for ${rule.id}? this will DENY matching tool calls, not just warn.`, enforceDefault);
    }
    selected.push({ id: rule.id, enforce });
  }
  return { selected };
}
