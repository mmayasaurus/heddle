import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { hermeticGit, useTempResources, initRepoFixture } from './helpers.js';
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

describe('plan_dispatch — previews the HED-723 clone refusal for the mcp and no_fallback the dispatch will pass', () => {
  const { tempDir } = useTempResources('heddle-plan-clone-');
  const REFUSAL = 'memtrace-standalone-clone';

  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it('drops the refusal when the dry run passes mcp: [] or no_fallback, as dispatch_worker would', async () => {
    const base = realpathSync(tempDir());
    const member = join(base, 'Project-Root');
    initRepoFixture(member, 'unused-worktree', { linkedWorktree: true });
    const clone = join(base, 'review-clone');
    hermeticGit(base, 'clone', '-q', member, clone);
    // The server child gets its own temp HOME: the manifest goes there, never into a real ~/.memtrace.
    const home = withTempHome();
    mkdirSync(join(home, '.memtrace', 'workspaces'), { recursive: true });
    writeFileSync(join(home, '.memtrace', 'workspaces', 'fleet.toml'), `[[members]]\npath = ${JSON.stringify(member)}\n`);
    const routing = join(base, 'routing.yaml');
    writeFileSync(routing, `version: 0
policy: {structural_caps: {max_children_per_orchestrator: 8, in_flight_stale_after_ms: 10800000}}
providers:
  codex: {auth: chatgpt-subscription, execution: headless, models: [gpt-5.6-luna]}
  cursor: {auth: cursor-subscription, execution: headless, models: [cursor-grok-4.6-high]}
task_classes:
  memtrace-worker: {provider: codex, model: gpt-5.6-luna, mcp: [memtrace], read_only: false, edits_code: false}
  cursor-on-fallback:
    provider: codex
    model: gpt-5.6-luna
    mcp: []
    fallback: {provider: cursor, model: cursor-grok-4.6-high, mcp: []}
    read_only: false
    edits_code: false
`);
    const mcp = await startMcp({ home, env: { HEDDLE_ROUTING: routing } });
    const preview = async (args: Record<string, unknown>) => JSON.stringify(await mcp.callTool('plan_dispatch', { cwd: clone, ...args }));

    expect(await preview({ task_class: 'memtrace-worker' })).toContain(REFUSAL);
    expect(await preview({ task_class: 'memtrace-worker', mcp: [] })).not.toContain(REFUSAL);
    expect(await preview({ task_class: 'cursor-on-fallback' })).toContain(REFUSAL);
    expect(await preview({ task_class: 'cursor-on-fallback', no_fallback: true })).not.toContain(REFUSAL);
    await mcp.close();
  }, 60_000);
});
