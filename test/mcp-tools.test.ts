import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { useTempResources, initRepoFixture } from './helpers.js';
import { ensureBuilt, withTempHome } from './helpers/cli.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';

function dispatchRecord(orchestrator: string | null = 'U') {
  return {
    orchestrator, taskClass: 'implementation', provider: 'claude', model: 'sonnet',
    skills: 'worker-role', issue: 'HED-120', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null,
  };
}

function textResult(result: Awaited<ReturnType<McpHarness['callTool']>>): unknown {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('expected text MCP result');
  return JSON.parse(content.text);
}

describe('heddle MCP tools', () => {
  let mcp: McpHarness | undefined;
  const { trackLedger } = useTempResources('heddle-mcp-tools-test-');

  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
  }, 30_000);

  it('lists the core dispatch and ledger tools', async () => {
    mcp = await startMcp();
    expect(await mcp.listTools()).toEqual(expect.arrayContaining([
      'dispatch_worker', 'get_dispatch', 'report_in_session', 'recent_dispatches',
    ]));
  }, 30_000);

  it('returns a seeded dispatch and reports an unknown dispatch as an error', async () => {
    const home = withTempHome();
    const ledger = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
    const id = ledger.start(dispatchRecord());
    ledger.finish(id, { ok: true, output: 'MCP-visible output' });
    ledger.close();
    mcp = await startMcp({ home });

    const found = await mcp.callTool('get_dispatch', { id });
    expect(found.isError).not.toBe(true);
    expect(textResult(found)).toMatchObject({ id, output: 'MCP-visible output' });

    const missing = await mcp.callTool('get_dispatch', { id: 999999 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('#999999') });
    expect(missing.content[0]).not.toMatchObject({ text: 'null' });
  }, 30_000);

  it.each([-100, 1.5])('rejects invalid report_in_session input_tokens (%s) without changing the refusal', async (inputTokens) => {
    const home = withTempHome();
    const ledger = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');
    mcp = await startMcp({ home });

    const result = await mcp.callTool('report_in_session', { id, ok: true, input_tokens: inputTokens });
    expect(result.isError).toBe(true);
    expect(ledger.get(id)).toMatchObject({ refusal: 'claude-in-session', ok: 0 });
    ledger.close();
  }, 30_000);

  it('does not report another orchestrator’s in-session handoff', async () => {
    const home = withTempHome();
    const ledger = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
    const id = ledger.refuse(dispatchRecord('OTHER'), 'claude-in-session', 'run this yourself', 'in-session');
    mcp = await startMcp({ home, env: { HEDDLE_AGENT: 'U' } });

    const result = await mcp.callTool('report_in_session', { id, ok: true });
    expect(result.isError).not.toBe(true);
    expect(textResult(result)).toEqual({ id, matched: false });
    expect(ledger.get(id)).toMatchObject({ orchestrator: 'OTHER', refusal: 'claude-in-session', ok: 0 });
    ledger.close();
  }, 30_000);
});

describe('plan_dispatch — the dry run names the gate the dispatch would resolve for its cwd (HED-389)', () => {
  const { tempDir } = useTempResources('heddle-plan-cwd-');

  it('resolves the repository gate for the given cwd, and drops the app gate for an unknown repository', async () => {
    const mcp = await startMcp();
    const heddle = initRepoFixture(join(tempDir(), 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });
    const unknown = initRepoFixture(join(tempDir(), 'unknown-repo'), 'worker');

    const inHeddle = JSON.stringify(await mcp.callTool('plan_dispatch', { task_class: 'bulk-mechanical', cwd: heddle }));
    expect(inHeddle).toContain('repo-heddle-core');
    expect(inHeddle).not.toContain('quality-gate');

    const inUnknown = JSON.stringify(await mcp.callTool('plan_dispatch', { task_class: 'bulk-mechanical', cwd: unknown }));
    expect(inUnknown).not.toContain('repo-heddle-core');
    expect(inUnknown).not.toContain('quality-gate');
  });
});
