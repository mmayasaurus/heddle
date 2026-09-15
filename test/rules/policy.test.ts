import { describe, expect, it } from 'vitest';
import { applyPolicy, type RulesPolicy } from '../../src/rules/policy.js';
import { parseRule, type Rule } from '../../src/rules/schema.js';

function rule(id: string, enforce: boolean): Rule {
  const parsed = parseRule({
    id,
    event: 'PreToolUse',
    match: {},
    action: 'block',
    enforce,
    subagent_aware: false,
    message: id,
    fail_open: true,
  }, id);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rule;
}

function policy(rules: RulesPolicy['rules']): RulesPolicy {
  return { schemaVersion: 1, rules };
}

describe('applyPolicy', () => {
  it('downgrades catalog enforcement when the selected policy rule is not enforced', () => {
    expect(applyPolicy([rule('sample-block', true)], policy([{ id: 'sample-block', enforce: false }]))[0]?.enforce).toBe(false);
  });

  it('downgrades an unselected catalog rule without removing it', () => {
    const source = rule('sample-block', true);
    const result = applyPolicy([source], policy([]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'sample-block', enforce: false });
  });

  it('preserves enforcement selected by both catalog and policy', () => {
    expect(applyPolicy([rule('sample-block', true)], policy([{ id: 'sample-block', enforce: true }]))[0]?.enforce).toBe(true);
  });

  it('caps a policy up-dial when catalog enforcement is false', () => {
    expect(applyPolicy([rule('sample-block', false)], policy([{ id: 'sample-block', enforce: true }]))[0]?.enforce).toBe(false);
  });

  it('preserves catalog order and does not mutate source rules', () => {
    const source = [rule('first-rule', true), rule('second-rule', true)];
    const result = applyPolicy(source, policy([{ id: 'second-rule', enforce: true }]));
    expect(result.map(({ id }) => id)).toEqual(['first-rule', 'second-rule']);
    expect(result.map(({ enforce }) => enforce)).toEqual([false, true]);
    expect(source.map(({ enforce }) => enforce)).toEqual([true, true]);
  });
});
