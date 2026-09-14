import { describe, expect, it } from 'vitest';
import { previewCase } from '../../src/rules/preview.js';
import { parseRule } from '../../src/rules/schema.js';

function rule(id: string, action: 'block' | 'nudge' | 'inject', enforce = false) {
  const parsed = parseRule({
    id,
    event: 'PreToolUse',
    match: { tool: 'SyntheticShell' },
    action,
    enforce,
    subagent_aware: false,
    message: 'synthetic guidance',
    fail_open: true,
  }, id);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rule;
}

describe('previewCase', () => {
  const matching = { hook_event_name: 'PreToolUse', tool_name: 'SyntheticShell' };
  const nonMatching = { hook_event_name: 'PreToolUse', tool_name: 'SyntheticEditor' };

  it('renders an unenforced block as a nudge and an enforced block as a block', () => {
    expect(previewCase(rule('synthetic-block', 'block'), matching)).toEqual({ name: '', matched: true, outcome: 'nudge' });
    expect(previewCase(rule('synthetic-block', 'block', true), matching)).toEqual({ name: '', matched: true, outcome: 'block' });
  });

  it('reports a non-match as none', () => {
    expect(previewCase(rule('synthetic-block', 'block'), nonMatching)).toEqual({ name: '', matched: false, outcome: 'none' });
  });

  it.each([
    ['nudge', 'nudge'],
    ['inject', 'inject'],
  ] as const)('maps %s actions to %s', (action, outcome) => {
    expect(previewCase(rule(`synthetic-${action}`, action), matching)).toEqual({ name: '', matched: true, outcome });
  });
});
