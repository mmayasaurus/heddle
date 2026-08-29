import type { Rule } from './schema.js';

export function renderMatches(event: string, matched: Array<{ rule: Rule; message: string }>): string {
  if (matched.length === 0) return '{}';
  const blocks = matched.filter(({ rule }) => rule.action === 'block' && rule.enforce);
  const context = matched.filter(({ rule }) => !(rule.action === 'block' && rule.enforce));
  if (blocks.length) {
    const reason = [blocks[0]!, ...context].map(({ message }) => message).join('\n');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context.map(({ message }) => message).join('\n') },
    systemMessage: `heddle rules: ${context.map(({ rule }) => rule.id).join(',')}`,
  });
}
