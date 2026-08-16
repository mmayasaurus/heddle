import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../src/types.js';

describe('dispatch — class + explicit route, and in-session refusal', () => {
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    ledgers.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-dispatch-test-'));
    dirs.push(dir);
    return dir;
  }

  function tempLedger(): Ledger {
    const ledger = new Ledger(join(tempDir(), 'ledger.db'));
    ledgers.push(ledger);
    return ledger;
  }

  function fakeAdapter(result: WorkerResult = { ok: true, output: 'done', exitCode: 0 }) {
    const calls: { prompt: string; opts: DispatchOptions; agents: string }[] = [];
    const adapter: WorkerAdapter = {
      name: 'fake', provider: 'codex',
      dispatch: async (prompt, opts) => {
        calls.push({ prompt, opts, agents: readFileSync(join(opts.cwd, 'AGENTS.md'), 'utf8') });
        return result;
      },
    };
    return { adapter, calls };
  }

  it('keeps class policy and ledger identity when an explicit provider and model replace the route', async () => {
    const cwd = tempDir();
    const ledger = tempLedger();
    const fake = fakeAdapter();
    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-sol', prompt: 'x', cwd, orchestrator: 'U' },
      ledger, () => fake.adapter,
    );
    expect(fake.calls[0].opts.model).toBe('gpt-5.6-sol');
    expect(outcome).toMatchObject({ taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-sol', usedFallback: false });
    expect(outcome.skills).toEqual(['worker-role', 'quality-gate']);
    expect(fake.calls[0].agents).toContain('### quality-gate');
    expect(ledger.recent(1)[0]).toMatchObject({ task_class: 'bulk-mechanical', model: 'gpt-5.6-sol', skills: 'worker-role,quality-gate', refusal: null, ok: 1 });
  });

  it('replaces class default skills with explicit skills while retaining worker-role', async () => {
    const fake = fakeAdapter();
    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-sol', prompt: 'x', cwd: tempDir(), skills: ['code-discovery'] },
      tempLedger(), () => fake.adapter,
    );
    expect(outcome.skills).toEqual(['worker-role', 'code-discovery']);
  });

  it('does not try a fallback after an explicitly selected route fails', async () => {
    const fake = fakeAdapter({ ok: false, output: '', exitCode: 1, error: 'boom' });
    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-sol', prompt: 'x', cwd: tempDir() },
      ledger, () => fake.adapter,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.usedFallback).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(ledger.recent(1)[0].ok).toBe(0);
  });

  it('enforces a class opt-in gate before invoking an explicitly selected route', async () => {
    const fake = fakeAdapter();
    await expect(dispatch(
      { taskClass: 'second-opinion-hard', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => fake.adapter,
    )).rejects.toThrow(/requires explicit opt-in/);
    expect(fake.calls).toHaveLength(0);
  });

  it('does not inherit effort into an explicit route unless the caller supplies it', async () => {
    const noEffort = fakeAdapter();
    await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => noEffort.adapter,
    );
    expect(noEffort.calls[0].opts.effort).toBeUndefined();

    const explicitEffort = fakeAdapter();
    await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), effort: 'high' },
      tempLedger(), () => explicitEffort.adapter,
    );
    expect(explicitEffort.calls[0].opts.effort).toBe('high');
  });

  it('records a class-routed Claude worker as a finished in-session refusal without invoking an adapter', async () => {
    const fake = fakeAdapter();
    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'implementation', prompt: 'x', cwd: tempDir(), orchestrator: 'U', issue: 'HED-1' },
      ledger, () => fake.adapter,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.execution).toBe('in-session-subagent');
    expect(outcome.refusal?.code).toBe('claude-in-session');
    expect(outcome.refusal?.reason).toContain('implementation');
    expect(outcome.refusal?.reason).toContain('claude/sonnet');
    for (const text of ['Agent tool', 'sonnet', 'worker-role', 'code-discovery', 'quality-gate', 'memtrace', 'gpt-5.6-terra']) expect(outcome.refusal?.instruction).toContain(text);
    expect(outcome.skills).toEqual(['worker-role', 'code-discovery', 'quality-gate']);
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'claude-in-session', ok: 0, task_class: 'implementation', provider: 'claude', model: 'sonnet', orchestrator: 'U', issue: 'HED-1', skills: 'worker-role,code-discovery,quality-gate' });
    expect(ledger.recent(1)[0].finished_at).not.toBeNull();
    expect(ledger.inFlight()).toEqual([]);
  });

  it('returns a structured in-session refusal for a direct Claude route without invoking an adapter', async () => {
    const fake = fakeAdapter();
    const ledger = tempLedger();
    const outcome = await dispatch({ provider: 'claude', model: 'opus', prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('claude-in-session');
    expect(outcome.taskClass).toBe('direct:claude/opus');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0].refusal).toBe('claude-in-session');
  });

  it('returns an in-session refusal for a class policy paired with an explicit Claude route', async () => {
    const fake = fakeAdapter();
    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', provider: 'claude', model: 'haiku', prompt: 'x', cwd: tempDir() },
      tempLedger(), () => fake.adapter,
    );
    expect(outcome.refusal?.code).toBe('claude-in-session');
    expect(outcome.taskClass).toBe('bulk-mechanical');
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a request with neither a task class nor an explicit provider+model, before touching any adapter or the ledger', async () => {
    const fake = fakeAdapter();
    const ledger = tempLedger();
    await expect(dispatch({ prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter))
      .rejects.toThrow(/requires either a task class or an explicit provider\+model/);
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)).toEqual([]);
  });

  it('words a direct claude route\'s refusal as a direct route, not a task class', async () => {
    const outcome = await dispatch({ provider: 'claude', model: 'opus', prompt: 'x', cwd: tempDir() }, tempLedger(), () => fakeAdapter().adapter);
    expect(outcome.refusal?.reason).toMatch(/^direct route claude\/opus names a provider that runs as an in-session subagent/);
    expect(outcome.refusal?.instruction).not.toContain('declared fallback');
  });

  it('runs a headless class primary without adding a refusal', async () => {
    const fake = fakeAdapter();
    const ledger = tempLedger();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir() }, ledger, () => fake.adapter);
    expect(outcome.ok).toBe(true);
    expect(outcome.refusal).toBeUndefined();
    expect([undefined, 'headless']).toContain(outcome.execution);
    expect(ledger.recent(1)[0].refusal).toBeNull();
  });
});
