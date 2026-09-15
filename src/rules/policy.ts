import { existsSync, readFileSync } from 'node:fs';
import type { HookRuleSelection } from '../wizard/hooks-choose.js';
import type { Rule } from './schema.js';

export interface RulesPolicy {
  schemaVersion: 1;
  rules: HookRuleSelection[];
}

export type RulesPolicyLoadResult =
  | { policy: RulesPolicy; warning?: never }
  | { policy?: never; warning: string };

function isRuleSelection(value: unknown): value is HookRuleSelection {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as HookRuleSelection).id === 'string'
    && typeof (value as HookRuleSelection).enforce === 'boolean';
}

export function loadRulesPolicy(path: string): RulesPolicyLoadResult {
  if (!existsSync(path)) return { warning: `rules policy not found at ${path}; using catalog enforcement` };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { warning: `rules policy at ${path} is not a v1 policy object; using catalog enforcement` };
    }
    const candidate = parsed as { schemaVersion?: unknown; rules?: unknown };
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.rules) || !candidate.rules.every(isRuleSelection)) {
      return { warning: `rules policy at ${path} is not a valid v1 policy; using catalog enforcement` };
    }
    return { policy: { schemaVersion: 1, rules: candidate.rules } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { warning: `rules policy at ${path} could not be read (${detail}); using catalog enforcement` };
  }
}

export function applyPolicy(rules: Rule[], policy: RulesPolicy): Rule[] {
  const selections = new Map(policy.rules.map((selection) => [selection.id, selection.enforce]));
  return rules.map((rule) => ({ ...rule, enforce: rule.enforce && selections.get(rule.id) === true }));
}
