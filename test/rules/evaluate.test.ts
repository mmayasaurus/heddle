import { describe, expect, it } from 'vitest';
import { evaluateRules, type EvalContext } from '../../src/rules/evaluate.js';
import { parseRule } from '../../src/rules/schema.js';

function rule(overrides: Record<string, unknown> = {}) {
  const result = parseRule({ id: 'rule', event: 'PreToolUse', match: {}, action: 'nudge', enforce: false, subagent_aware: false, message: 'x', fail_open: true, ...overrides }, 'rule');
  if (!result.ok) throw new Error(result.error); return result.rule;
}
const ctx = (overrides: Partial<EvalContext> = {}): EvalContext => ({ event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'rg foo -r' }, cwd: '/a/b/c' }, isSubagent: false, agentRole: 'orchestrator', agent: '', ...overrides });
const verdict = (r: ReturnType<typeof rule>, c = ctx()) => evaluateRules([r], c)[0]!.verdict;

describe('rule evaluation', () => {
  it('matches tool names exactly and rejects other tools', () => { expect(verdict(rule({ match: { tool: ['Bash'] } }))).toBe('match'); expect(verdict(rule({ match: { tool: 'Read' } }))).toBe('no-match'); });
  it('matches input regexes against tool input strings', () => { const r = rule({ match: { input: { command: '\\b(rg|grep)\\b.*(-r|--recursive)' } } }); expect(verdict(r)).toBe('match'); expect(verdict(r, ctx({ payload: { tool_name: 'Bash', tool_input: { command: 'rg foo' } } }))).toBe('no-match'); });
  it('makes cwd prefixes path-segment aware', () => { const r = rule({ match: { cwd: '/a/b' } }); expect(verdict(r)).toBe('match'); expect(verdict(r, ctx({ payload: { cwd: '/a/bc' } }))).toBe('no-match'); });
  it('skips a rule for the wrong agent role', () => expect(verdict(rule({ match: { agent_role: 'worker' } }))).toBe('skip-role'));
  it('skips non-subagent-aware rules in a subagent', () => expect(verdict(rule(), ctx({ isSubagent: true, payload: { agent_id: 'x' } }))).toBe('skip-subagent'));
  it('evaluates subagent-aware rules in a subagent', () => expect(verdict(rule({ subagent_aware: true }), ctx({ isSubagent: true }))).toBe('match'));
  it('skips rules for another event', () => expect(verdict(rule(), ctx({ event: 'Stop' }))).toBe('skip-event'));
});
