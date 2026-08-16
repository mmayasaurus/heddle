import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../src/types.js';

describe('dispatch — review fixes', () => {
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    ledgers.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-dispatch-review-test-'));
    dirs.push(dir);
    return dir;
  }

  function tempLedger(): Ledger {
    const ledger = new Ledger(join(tempDir(), 'ledger.db'));
    ledgers.push(ledger);
    return ledger;
  }

  function fakeAdapter(result: WorkerResult = { ok: true, output: 'done', exitCode: 0 }) {
    const calls: { prompt: string; opts: DispatchOptions }[] = [];
    const adapter: WorkerAdapter = {
      name: 'fake', provider: 'codex',
      dispatch: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return result;
      },
    };
    return { adapter, calls };
  }

  it('rejects incomplete explicit routes before invoking an adapter', async () => {
    const fake = fakeAdapter();
    await expect(dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => fake.adapter,
    )).rejects.toThrow(/provider and model must be given together/);
    await expect(dispatch(
      { model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => fake.adapter,
    )).rejects.toThrow(/provider and model must be given together/);
    expect(fake.calls).toHaveLength(0);
  });

  it('words in-session refusals according to how the route originated', async () => {
    const classOutcome = await dispatch(
      { taskClass: 'implementation', prompt: 'x', cwd: tempDir() }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(classOutcome.refusal?.reason).toMatch(/^task class "implementation" routes to claude\/sonnet, which/);

    const explicitOutcome = await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'claude', model: 'haiku', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => fakeAdapter().adapter,
    );
    expect(explicitOutcome.refusal?.reason).toMatch(/^task class "bulk-mechanical" was given the explicit route claude\/haiku, which/);
    expect(explicitOutcome.refusal?.instruction).toContain('provider="cursor", model="composer-2.5-fast"');

    const directOutcome = await dispatch(
      { provider: 'claude', model: 'opus', prompt: 'x', cwd: tempDir() }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(directOutcome.refusal?.reason).toMatch(/^direct route claude\/opus names a provider that/);
  });

  it('honors an MCP override in the in-session instruction', async () => {
    const noMcp = await dispatch(
      { taskClass: 'implementation', prompt: 'x', cwd: tempDir(), mcp: [] }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(noMcp.refusal?.instruction).not.toContain('memtrace');

    const overridden = await dispatch(
      { taskClass: 'implementation', prompt: 'x', cwd: tempDir(), mcp: ['serena'] }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(overridden.refusal?.instruction).toContain('MCP [serena]');
    expect(overridden.refusal?.instruction).not.toContain('memtrace');
  });

  it('refuses the non-dispatchable orchestration class on every path, without worker packs', async () => {
    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'orchestration', prompt: 'x', cwd: tempDir() }, ledger, () => fakeAdapter().adapter,
    );
    expect(outcome.refusal?.code).toBe('not-dispatchable');
    expect(outcome.refusal?.reason).toContain('dispatchable: false');
    expect(outcome.refusal?.instruction).toContain('Continue yourself');
    expect(outcome.refusal?.instruction).not.toContain('worker-role');
    expect(outcome.refusal?.instruction).not.toContain('Agent tool');
    expect(outcome.skills).toEqual([]);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'not-dispatchable', skills: null });
    // naming a headless subprocess route does not turn the orchestrator's own work into a worker task
    const fake = fakeAdapter();
    const explicit = await dispatch(
      { taskClass: 'orchestration', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter,
    );
    expect(explicit.refusal?.code).toBe('not-dispatchable');
    expect(explicit.refusal?.reason).toContain('codex/gpt-5.6-luna');
    // structured fields + ledger row name the route the caller actually asked for
    expect(explicit).toMatchObject({ taskClass: 'orchestration', provider: 'codex', model: 'gpt-5.6-luna' });
    expect(ledger.recent(1)[0]).toMatchObject({ task_class: 'orchestration', provider: 'codex', model: 'gpt-5.6-luna', refusal: 'not-dispatchable' });
    expect(fake.calls).toHaveLength(0);
    // even an excluded/unknown named provider yields the structured, ledgered refusal (no throw)
    const excluded = await dispatch(
      { taskClass: 'orchestration', provider: 'ollama-cloud', model: 'x', prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter,
    );
    expect(excluded.refusal?.code).toBe('not-dispatchable');
    expect(excluded).toMatchObject({ provider: 'ollama-cloud', model: 'x' });
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'not-dispatchable', provider: 'ollama-cloud' });
  });

  it('records a failed primary before refusing an in-session fallback', async () => {
    const routingPath = join(tempDir(), 'routing.yaml');
    writeFileSync(routingPath, `providers:\n  codex: { execution: headless, models: [m1] }\n  claude: { execution: in-session-subagent, models: [sonnet] }\ntask_classes:\n  synth: { provider: codex, model: m1, fallback: { provider: claude, model: sonnet }, skills: [worker-role] }\n`);
    const previous = process.env.HEDDLE_ROUTING;
    const ledger = tempLedger();
    const fake = fakeAdapter({ ok: false, output: '', exitCode: 1, error: 'primary down' });

    try {
      process.env.HEDDLE_ROUTING = routingPath;
      const outcome = await dispatch({ taskClass: 'synth', prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter);
      expect(outcome.refusal?.code).toBe('claude-in-session');
      expect(outcome.usedFallback).toBe(true);
      expect(outcome.refusal?.reason).toContain('fell back to claude/sonnet (its declared fallback)');
      expect(fake.calls).toHaveLength(1);
      const [newest, older] = ledger.recent(2);
      expect(newest).toMatchObject({ refusal: 'claude-in-session', fell_back_from: 'codex/m1' });
      expect(older).toMatchObject({ ok: 0, error: 'primary down' });
    } finally {
      if (previous === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = previous;
    }
  });

  it('reports the declared provider execution on successful class and direct routes', async () => {
    const classOutcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir() }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(classOutcome.execution).toBe('headless');

    const directOutcome = await dispatch(
      { provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir() }, tempLedger(), () => fakeAdapter().adapter,
    );
    expect(directOutcome.execution).toBe('headless');
  });
});
