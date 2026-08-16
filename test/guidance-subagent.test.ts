import { describe, it, expect } from 'vitest';
import { hookResponse } from '../src/guidance.js';
import { loadRouting } from '../src/routing.js';

const table = loadRouting();

describe('hookResponse subagent guidance', () => {
  it('warns a class-routed subagent about the depth-1 structural cap', () => {
    const response = hookResponse({ tool_name: 'mcp__heddle__dispatch_worker', tool_input: { task_class: 'bulk-mechanical' }, agent_id: 'a1', agent_type: 'Explore' }, table);
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('inside a subagent');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Explore a1');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('depth-1');
    expect(parsed.systemMessage).toContain('subagent-dispatch (bulk-mechanical)');
    expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('stays silent for a clean orchestrator dispatch and an empty agent identity', () => {
    const payload = { tool_name: 'mcp__heddle__dispatch_worker', tool_input: { task_class: 'bulk-mechanical' } };
    expect(hookResponse(payload, table)).toBeNull();
    expect(hookResponse({ ...payload, agent_id: '' }, table)).toBeNull();
  });

  it('names the direct provider and model in a subagent guidance message', () => {
    const response = hookResponse({ tool_name: 'mcp__heddle__dispatch_worker', tool_input: { provider: 'codex', model: 'gpt-5.6-luna' }, agent_id: 'a1' }, table);
    expect(response).not.toBeNull();
    expect(JSON.parse(response!).systemMessage).toContain('subagent-dispatch (direct:codex/gpt-5.6-luna)');
  });
});
