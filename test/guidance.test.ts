import { describe, it, expect } from 'vitest';
import { dispatchGuidance, hookResponse, taskFitPacks } from '../src/guidance.js';
import type { RoutingTable } from '../src/routing.js';

const table: RoutingTable = {
  version: 0,
  policy: {},
  providers: { codex: { models: ['m1'] }, cursor: { models: ['k1'] } },
  taskClasses: {
    'edit-with-defaults': { provider: 'codex', model: 'm1', edits_code: true, skills: ['worker-role', 'quality-gate', 'code-discovery'] },
    'edit-no-defaults': { provider: 'codex', model: 'm1', edits_code: true },
    review: { provider: 'cursor', model: 'k1', edits_code: false, skills: ['worker-role'] },
    gated: { provider: 'cursor', model: 'k1', edits_code: false, requires_explicit_opt_in: true, note: 'burns the metered pool' },
    'gated-edit': { provider: 'codex', model: 'm1', edits_code: true, requires_explicit_opt_in: true, note: 'costly' },
    stringy: { provider: 'codex', model: 'm1', edits_code: 'true' },
  },
};

describe('dispatchGuidance', () => {
  it('warns when an editing dispatch explicitly removes all task-fit defaults', () => {
    const warnings = dispatchGuidance(table, { task_class: 'edit-with-defaults', skills: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('code-editing-class-without-skills');
    expect(warnings[0].task_class).toBe('edit-with-defaults');
    expect(warnings[0].message).toContain('EDITS CODE');
    expect(warnings[0].message).toContain('quality-gate, code-discovery');
    expect(warnings[0].message).toContain('[worker-role, quality-gate, code-discovery]');
  });

  it('stays silent when an editing class receives its omitted default skills', () => {
    expect(dispatchGuidance(table, { task_class: 'edit-with-defaults' })).toEqual([]);
  });

  it('explains when an editing class has no task-fit defaults to apply', () => {
    const warnings = dispatchGuidance(table, { task_class: 'edit-no-defaults' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('code-editing-class-without-skills');
    expect(warnings[0].task_class).toBe('edit-no-defaults');
    expect(warnings[0].message).toContain('lists no default packs');
  });

  it('treats worker-role alone as governance rather than a task-fit pack', () => {
    const warnings = dispatchGuidance(table, { task_class: 'edit-with-defaults', skills: ['worker-role'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('code-editing-class-without-skills');
    expect(warnings[0].task_class).toBe('edit-with-defaults');
  });

  it('accepts an explicit non-default task-fit pack for an editing dispatch', () => {
    expect(dispatchGuidance(table, { task_class: 'edit-with-defaults', skills: ['supabase-dev'] })).toEqual([]);
  });

  it('does not warn about missing task-fit packs for a non-editing class', () => {
    expect(dispatchGuidance(table, { task_class: 'review', skills: [] })).toEqual([]);
  });

  it('warns about a gated class without an explicit opt-in and states its route and note', () => {
    const warnings = dispatchGuidance(table, { task_class: 'gated' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('opt-in-required');
    expect(warnings[0].task_class).toBe('gated');
    expect(warnings[0].message).toContain('opt_in: true');
    expect(warnings[0].message).toContain('burns the metered pool');
    expect(warnings[0].message).toContain('cursor/k1');
  });

  it('stays silent for a gated class when opt_in is explicitly true', () => {
    expect(dispatchGuidance(table, { task_class: 'gated', opt_in: true })).toEqual([]);
  });

  it('treats opt_in false as missing opt-in for a gated class', () => {
    const warnings = dispatchGuidance(table, { task_class: 'gated', opt_in: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('opt-in-required');
    expect(warnings[0].task_class).toBe('gated');
  });

  it('returns the missing-skill warning before the opt-in warning for a gated editing class', () => {
    const warnings = dispatchGuidance(table, { task_class: 'gated-edit', skills: [] });
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.code)).toEqual(['code-editing-class-without-skills', 'opt-in-required']);
    expect(warnings.map((warning) => warning.task_class)).toEqual(['gated-edit', 'gated-edit']);
  });

  it('ignores an unknown task class because the dispatcher owns that validation error', () => {
    expect(dispatchGuidance(table, { task_class: 'no-such-class', skills: [] })).toEqual([]);
  });

  it('does not apply class guidance to a direct provider and model dispatch', () => {
    expect(dispatchGuidance(table, { provider: 'codex', model: 'm1', skills: [] })).toEqual([]);
  });

  it('requires edits_code to be the boolean true before applying editing guidance', () => {
    expect(dispatchGuidance(table, { task_class: 'stringy', skills: [] })).toEqual([]);
  });
});

describe('taskFitPacks', () => {
  it('returns a class default without the mandatory governance pack', () => {
    expect(taskFitPacks(table, { task_class: 'edit-with-defaults' })).toEqual(['quality-gate', 'code-discovery']);
  });

  it('uses an explicit skill list instead of the class defaults', () => {
    expect(taskFitPacks(table, { task_class: 'edit-with-defaults', skills: ['x'] })).toEqual(['x']);
  });

  it('removes duplicate mandatory packs from an explicit non-editing skill list', () => {
    expect(taskFitPacks(table, { task_class: 'review', skills: ['worker-role', 'worker-role'] })).toEqual([]);
  });
});

describe('hookResponse', () => {
  it('ignores a non-dispatch tool invocation', () => {
    expect(hookResponse({ tool_name: 'Bash', tool_input: { command: 'ls' } }, table)).toBeNull();
  });

  it('stays silent for a dispatch with no guidance warnings', () => {
    expect(hookResponse({ tool_name: 'mcp__heddle__dispatch_worker', tool_input: { task_class: 'edit-with-defaults' } }, table)).toBeNull();
  });

  it('returns a non-blocking opt-in nudge for a gated dispatch tool call', () => {
    const response = hookResponse({ tool_name: 'mcp__heddle__dispatch_worker', tool_input: { task_class: 'gated' } }, table);
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('opt_in: true');
    expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(parsed.systemMessage).toContain('opt-in-required');
    expect(parsed.systemMessage).toContain('gated');
  });

  it('matches the bare dispatch_worker name but not a suffixed tool name', () => {
    expect(hookResponse({ tool_name: 'dispatch_worker', tool_input: { task_class: 'gated' } }, table)).not.toBeNull();
    expect(hookResponse({ tool_name: 'mcp__heddle__dispatch_workers', tool_input: { task_class: 'gated' } }, table)).toBeNull();
  });

  it('returns null for absent payload data without throwing', () => {
    expect(hookResponse(null, table)).toBeNull();
    expect(hookResponse({ tool_name: 'mcp__heddle__dispatch_worker' }, table)).toBeNull();
  });

  it('joins two warning messages into context and names both warning codes in the system message', () => {
    const response = hookResponse({ tool_name: 'mcp__heddle__dispatch_worker', tool_input: { task_class: 'gated-edit', skills: [] } }, table);
    const parsed = JSON.parse(response!);
    const warnings = dispatchGuidance(table, { task_class: 'gated-edit', skills: [] });
    expect(parsed.hookSpecificOutput.additionalContext).toBe(warnings.map((warning) => warning.message).join('\n'));
    expect(parsed.systemMessage).toContain('code-editing-class-without-skills');
    expect(parsed.systemMessage).toContain('opt-in-required');
  });
});
