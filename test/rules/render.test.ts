import { describe, expect, it } from 'vitest';
import { renderMatches } from '../../src/rules/render.js';
import { parseRule } from '../../src/rules/schema.js';

function rule(overrides: Record<string, unknown> = {}) { const result = parseRule({ id: 'rule', event: 'PreToolUse', match: {}, action: 'nudge', enforce: false, subagent_aware: false, message: 'x', fail_open: true, ...overrides }, 'rule'); if (!result.ok) throw new Error(result.error); return result.rule; }
describe('rule rendering', () => {
  it('renders an enforced PreToolUse block as deny without additional context', () => { const out = JSON.parse(renderMatches('PreToolUse', [{ rule: rule({ action: 'block', enforce: true }), message: 'no' }])); expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }); });
  it('renders a nudge using the production context shape', () => { const out = JSON.parse(renderMatches('SessionStart', [{ rule: rule({ event: 'SessionStart', action: 'nudge' }), message: 'hello' }])); expect(out.hookSpecificOutput.additionalContext).toBe('hello'); expect(out.systemMessage).toBe('heddle rules: rule'); expect(out.hookSpecificOutput.permissionDecision).toBeUndefined(); });
  it('renders non-enforced blocks as prefixed context', () => { const out = JSON.parse(renderMatches('PreToolUse', [{ rule: rule({ action: 'block' }), message: '(would block) stop' }])); expect(out.hookSpecificOutput.additionalContext).toContain('(would block) '); });
  it('renders no matches as an empty object', () => expect(renderMatches('Stop', [])).toBe('{}'));
});
