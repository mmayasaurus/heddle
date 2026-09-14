import { loadRules } from '../rules/load.js';
import type { HookRuleSelection } from './hooks-choose.js';

export type SafetyPreset = 'minimal' | 'standard' | 'strict';

const PRESET_RULE_IDS: Record<SafetyPreset, readonly string[]> = {
  minimal: ['no-rm-recursive-force'],
  standard: ['no-rm-recursive-force', 'no-git-history-rewrite', 'no-git-worktree-discard', 'pr-flow-reminder'],
  strict: ['no-rm-recursive-force', 'no-git-history-rewrite', 'no-git-worktree-discard', 'no-destructive-sql', 'pr-flow-reminder'],
};

export const PRESET_TIERS: SafetyPreset[] = ['minimal', 'standard', 'strict'];

export function resolvePreset(tier: SafetyPreset, catalogRoot: string): HookRuleSelection[] {
  if (!PRESET_TIERS.includes(tier)) throw new Error(`unknown safety preset '${tier}' (choose ${PRESET_TIERS.join(', ')})`);
  const ids = PRESET_RULE_IDS[tier];
  const catalogIds = new Set(loadRules(catalogRoot).map((rule) => rule.id));
  const missing = ids.filter((id) => !catalogIds.has(id));
  if (missing.length) throw new Error(`safety preset '${tier}' requires catalog rule(s) not found: ${missing.join(', ')}`);
  return ids.map((id) => ({ id, enforce: false }));
}
