import type { Rule } from './schema.js';

export type MatchedRuleOutcome = 'block' | 'nudge' | 'inject';

/** The observable hook outcome for one matched rule. */
export function matchedRuleOutcome(rule: Rule): MatchedRuleOutcome {
  if (rule.action === 'block') return rule.enforce ? 'block' : 'nudge';
  return rule.action;
}

export function renderMatches(event: string, matched: Array<{ rule: Rule; message: string }>): string {
  if (matched.length === 0) return '{}';
  const blocks = matched.filter(({ rule }) => matchedRuleOutcome(rule) === 'block');
  const context = matched.filter(({ rule }) => matchedRuleOutcome(rule) !== 'block');
  if (blocks.length) {
    if (event !== 'PreToolUse') throw new Error('block render is PreToolUse-only');
    const reason = [...blocks, ...context].map(({ message }) => message).join('\n');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context.map(({ message }) => message).join('\n') },
    systemMessage: `heddle rules: ${context.map(({ rule }) => rule.id).join(',')}`,
  });
}
