import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
import { normalizedBoundedUsage } from '../src/bounded-dispatch.js';
import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../src/types.js';
import type { DispatchRequest } from '../src/dispatcher/types.js';
import { useTempResources } from './helpers.js';

const TASK_CLASS = 'fdl-public-source-research';
const priorRouting = process.env.HEDDLE_ROUTING;

function fakeGlm(result: WorkerResult = {
  ok: true,
  output: '{"finding":"bounded"}',
  exitCode: null,
  raw: { id: 'provider-request-1', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  usage: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, cacheCreationInputTokens: 3, requestId: 'provider-request-1' },
}): { adapter: WorkerAdapter; calls: Array<{ prompt: string; opts: DispatchOptions }> } {
  const calls: Array<{ prompt: string; opts: DispatchOptions }> = [];
  const adapter: WorkerAdapter = {
    name: 'fake-glm',
    provider: 'glm',
    dispatch: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return result;
    },
  };
  return { adapter, calls };
}

function admission(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `request-${Math.random()}`,
    sessionId: 'fdl-session',
    account: 'zai-coding-plan',
    remainingTokens: 2_400_000,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function boundedRequest(cwd: string, overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    taskClass: TASK_CLASS,
    prompt: 'analyze this packet',
    cwd,
    optIn: true,
    noFallback: true,
    boundedAdmission: admission(),
    ...overrides,
  };
}

function boundedRouting(sessionTokenCap = 2_400_000, fallback = false): string {
  return `version: 0
policy:
  structural_caps: {max_children_per_orchestrator: 8, in_flight_stale_after_ms: 10800000}
providers:
  glm: {auth: zai-coding-plan-subscription, billing_class: subscription-quota, execution: headless, models: [glm-5.3]}
  codex: {auth: chatgpt-subscription, execution: headless, models: [gpt-5.6-luna]}
task_classes:
  ${TASK_CLASS}:
    provider: glm
    model: glm-5.3
    ${fallback ? 'fallback: {provider: codex, model: gpt-5.6-luna}' : ''}
    requires_explicit_opt_in: true
    read_only: true
    skills: []
    edits_code: false
    bounds:
      account: zai-coding-plan
      max_model_requests: 1
      max_input_tokens: 72000
      max_generated_tokens: 8000
      max_total_tokens: 80000
      max_output_bytes: 16000
      max_concurrency: 1
      timeout_ms: 150000
      max_dispatches_per_hour: 4
      max_dispatches_per_session: 48
      max_session_tokens: ${sessionTokenCap}
      max_headroom_age_ms: 300000
      retry: false
`;
}

describe('bounded FDL dispatch admission', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-bounded-dispatch-');

  afterEach(() => {
    if (priorRouting === undefined) delete process.env.HEDDLE_ROUTING;
    else process.env.HEDDLE_ROUTING = priorRouting;
  });

  it('refuses oversized assembled input before the provider is called', async () => {
    const fake = fakeGlm();
    let factoryCalls = 0;
    const outcome = await dispatch(
      boundedRequest(tempDir(), { prompt: 'x'.repeat(72_001) }),
      tempLedger(), () => { factoryCalls += 1; return fake.adapter; },
    );
    expect(outcome.refusal?.code).toBe('bounded-input-oversize');
    expect(factoryCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a provider without native request/output enforcement before the provider is called', async () => {
    const fake = fakeGlm();
    let factoryCalls = 0;
    const outcome = await dispatch(
      boundedRequest(tempDir(), { provider: 'codex', model: 'gpt-5.6-luna' }),
      tempLedger(), () => { factoryCalls += 1; return fake.adapter; },
    );
    expect(outcome.refusal?.code).toBe('bounded-unsupported-bound');
    expect(outcome.boundedReceipt).toBeDefined();
    expect(outcome.boundedReceipt!.refusedDimensions).toEqual(expect.arrayContaining(['modelRequests', 'generatedTokens']));
    expect(fake.calls).toHaveLength(0);
    expect(factoryCalls).toBe(0);
  });

  it('refuses unknown and stale account headroom before the provider is called', async () => {
    const fake = fakeGlm();
    const unknown = await dispatch(
      boundedRequest(tempDir(), { boundedAdmission: undefined }),
      tempLedger(), () => fake.adapter,
    );
    expect(unknown.refusal?.code).toBe('bounded-headroom-unknown');

    const stale = await dispatch(
      boundedRequest(tempDir(), { boundedAdmission: admission({ observedAt: new Date(Date.now() - 300_001).toISOString() }) }),
      tempLedger(), () => fake.adapter,
    );
    expect(stale.refusal?.code).toBe('bounded-headroom-stale');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a caller account that differs from the bounded route account', async () => {
    const outcome = await dispatch(
      boundedRequest(tempDir(), { boundedAdmission: admission({ account: 'other-account' }) }),
      tempLedger(), () => fakeGlm().adapter,
    );
    expect(outcome.refusal?.code).toBe('bounded-account-mismatch');
    expect(outcome.boundedReceipt?.refusedDimensions).toEqual(['accountIdentity']);
  });

  it('finishes and settles a reservation when adapter construction fails after admission', async () => {
    const dir = tempDir();
    const ledgerPath = join(dir, 'ledger.db');
    const ledger = new Ledger(ledgerPath);
    const failed = await dispatch(boundedRequest(dir), ledger, () => { throw new Error('adapter unavailable'); });
    expect(failed).toMatchObject({ ok: false, error: 'post-admission failure: adapter unavailable' });
    const db = new DatabaseSync(ledgerPath);
    expect(db.prepare('SELECT ok, finished_at FROM dispatches WHERE id = ?').get(failed.ledgerId))
      .toMatchObject({ ok: 0, finished_at: expect.any(String) });
    expect(db.prepare('SELECT actual_total_tokens, settled_at FROM bounded_reservations WHERE dispatch_id = ?').get(failed.ledgerId))
      .toMatchObject({ actual_total_tokens: null, settled_at: expect.any(String) });
    db.close();
    const next = await dispatch(
      boundedRequest(dir, { boundedAdmission: admission({ requestId: 'after-adapter-failure' }) }),
      ledger, () => fakeGlm().adapter,
    );
    expect(next.ok).toBe(true);
  });

  it('normalizes only finite safe non-negative integer provider usage', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5'] as unknown[]) {
      expect(normalizedBoundedUsage({ inputTokens: value, outputTokens: value } as TokenUsage))
        .toMatchObject({ inputTokens: null, generatedTokens: null, totalTokens: null });
    }
  });

  it('atomically refuses an exhausted session-token budget before a second provider call', async () => {
    const dir = tempDir();
    const routingPath = join(dir, 'routing.yaml');
    writeFileSync(routingPath, boundedRouting(80_000));
    process.env.HEDDLE_ROUTING = routingPath;
    const ledger = tempLedger();
    const fake = fakeGlm({
      ok: true,
      output: '{"finding":"uses the complete envelope"}',
      exitCode: null,
      usage: { inputTokens: 72_000, outputTokens: 8_000, reasoningOutputTokens: 2_000, cacheCreationInputTokens: 3_000 },
    });
    const first = await dispatch(boundedRequest(dir), ledger, () => fake.adapter);
    expect(first.ok).toBe(true);
    const second = await dispatch(
      boundedRequest(dir, { boundedAdmission: admission({ requestId: 'second-request' }) }),
      ledger, () => fake.adapter,
    );
    expect(second.refusal?.code).toBe('bounded-aggregate-exhausted');
    expect(fake.calls).toHaveLength(1);
  });

  it('does not reuse a settled spend that the same headroom snapshot could not have seen', async () => {
    const ledger = tempLedger();
    const observedAt = new Date(Date.now() - 1_000).toISOString();
    const fake = fakeGlm({
      ok: true, output: '{"finding":"spent"}', exitCode: null,
      usage: { inputTokens: 72_000, outputTokens: 8_000 },
    });
    const first = await dispatch(
      boundedRequest(tempDir(), { prompt: 'x'.repeat(71_900), boundedAdmission: admission({ requestId: 'spent-first', remainingTokens: 100_000, observedAt }) }),
      ledger, () => fake.adapter,
    );
    expect(first.ok).toBe(true);
    const staleSnapshot = await dispatch(
      boundedRequest(tempDir(), { prompt: 'x'.repeat(71_900), boundedAdmission: admission({ requestId: 'spent-second', remainingTokens: 100_000, observedAt }) }),
      ledger, () => fake.adapter,
    );
    expect(staleSnapshot.refusal?.code).toBe('bounded-aggregate-exhausted');
    const freshSnapshot = await dispatch(
      boundedRequest(tempDir(), { boundedAdmission: admission({ requestId: 'spent-third', remainingTokens: 20_000, observedAt: new Date().toISOString() }) }),
      ledger, () => fake.adapter,
    );
    expect(freshSnapshot.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('counts settled spend admitted after a no-millis headroom snapshot', async () => {
    const now = Date.parse('2026-09-15T16:00:00.050Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const dir = tempDir();
      const ledgerPath = join(dir, 'ledger.db');
      const ledger = new Ledger(ledgerPath);
      const fake = fakeGlm();
      const first = await dispatch(boundedRequest(dir, {
        boundedAdmission: admission({ requestId: 'no-millis-first', observedAt: new Date(now).toISOString() }),
      }), ledger, () => fake.adapter);
      const db = new DatabaseSync(ledgerPath);
      const reservation = db.prepare('SELECT reserved_total_tokens FROM bounded_reservations WHERE dispatch_id = ?').get(first.ledgerId) as { reserved_total_tokens: number };
      db.close();
      const second = await dispatch(boundedRequest(dir, {
        boundedAdmission: admission({ requestId: 'no-millis-second', observedAt: '2026-09-15T16:00:00Z', remainingTokens: reservation.reserved_total_tokens + 14 }),
      }), ledger, () => fake.adapter);
      expect(second.refusal).toMatchObject({ code: 'bounded-aggregate-exhausted', reason: expect.stringContaining('15 are already outstanding') });
    } finally {
      clock.mockRestore();
    }
  });

  it('counts settled spend admitted after an offset-form headroom snapshot', async () => {
    const now = Date.parse('2026-09-15T16:00:00.050Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const dir = tempDir();
      const ledgerPath = join(dir, 'ledger.db');
      const ledger = new Ledger(ledgerPath);
      const fake = fakeGlm();
      const first = await dispatch(boundedRequest(dir, {
        boundedAdmission: admission({ requestId: 'offset-first', observedAt: new Date(now).toISOString() }),
      }), ledger, () => fake.adapter);
      const db = new DatabaseSync(ledgerPath);
      const reservation = db.prepare('SELECT reserved_total_tokens FROM bounded_reservations WHERE dispatch_id = ?').get(first.ledgerId) as { reserved_total_tokens: number };
      db.close();
      const second = await dispatch(boundedRequest(dir, {
        boundedAdmission: admission({ requestId: 'offset-second', observedAt: '2026-09-15T18:00:00+02:00', remainingTokens: reservation.reserved_total_tokens + 14 }),
      }), ledger, () => fake.adapter);
      expect(second.refusal).toMatchObject({ code: 'bounded-aggregate-exhausted', reason: expect.stringContaining('15 are already outstanding') });
    } finally {
      clock.mockRestore();
    }
  });

  it('releases an orphaned concurrency slot while retaining its tokens, but keeps fresh slots occupied', async () => {
    const dir = tempDir();
    const ledgerPath = join(dir, 'ledger.db');
    const ledger = new Ledger(ledgerPath);
    const fake = fakeGlm();
    const first = await dispatch(boundedRequest(dir, {
      boundedAdmission: admission({ requestId: 'orphan-first' }),
    }), ledger, () => fake.adapter);
    const db = new DatabaseSync(ledgerPath);
    const reservation = db.prepare('SELECT reserved_total_tokens FROM bounded_reservations WHERE dispatch_id = ?').get(first.ledgerId) as { reserved_total_tokens: number };
    const orphanAt = new Date(Date.now() - 10_861_000).toISOString();
    db.prepare('UPDATE dispatches SET finished_at = NULL WHERE id = ?').run(first.ledgerId);
    db.prepare('UPDATE bounded_reservations SET admitted_at = ? WHERE dispatch_id = ?').run(orphanAt, first.ledgerId);
    db.close();
    const headroomRefusal = await dispatch(boundedRequest(dir, {
      boundedAdmission: admission({ requestId: 'orphan-second', remainingTokens: reservation.reserved_total_tokens }),
    }), ledger, () => fake.adapter);
    expect(headroomRefusal.refusal).toMatchObject({ code: 'bounded-aggregate-exhausted', reason: expect.stringContaining('already outstanding') });
    const freshDb = new DatabaseSync(ledgerPath);
    freshDb.prepare('UPDATE bounded_reservations SET admitted_at = ? WHERE dispatch_id = ?').run(new Date().toISOString(), first.ledgerId);
    freshDb.close();
    const concurrencyRefusal = await dispatch(boundedRequest(dir, {
      boundedAdmission: admission({ requestId: 'fresh-second', remainingTokens: 2_400_000 }),
    }), ledger, () => fake.adapter);
    expect(concurrencyRefusal.refusal).toMatchObject({ code: 'bounded-aggregate-exhausted', reason: expect.stringContaining('in flight') });
  });

  it('refuses a configured fallback before the provider is called', async () => {
    const dir = tempDir();
    const routingPath = join(dir, 'routing.yaml');
    writeFileSync(routingPath, boundedRouting(2_400_000, true));
    process.env.HEDDLE_ROUTING = routingPath;
    const fake = fakeGlm();
    const outcome = await dispatch(boundedRequest(dir), tempLedger(), () => fake.adapter);
    expect(outcome.refusal?.code).toBe('bounded-forbidden-fallback');
    expect(fake.calls).toHaveLength(0);
  });

  it('pins one GLM request and normalizes reasoning and cache creation without double counting', async () => {
    const fake = fakeGlm();
    const dir = tempDir();
    const ledgerPath = join(dir, 'ledger.db');
    const ledger = new Ledger(ledgerPath);
    const outcome = await dispatch(boundedRequest(dir), ledger, () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts).toMatchObject({
      model: 'glm-5.3', maxOutputTokens: 8_000, maxModelRequests: 1,
      allowReasoningRetry: false, timeoutMs: 150_000, readOnly: true,
    });
    expect(outcome.boundedReceipt).toBeDefined();
    expect(outcome.boundedReceipt!).toMatchObject({
      status: 'completed',
      provider: 'glm',
      model: 'glm-5.3',
      account: 'zai-coding-plan',
      normalizedUsage: {
        inputTokens: 10,
        cacheCreationInputTokens: 3,
        generatedTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
      },
      enforcementSupport: {
        modelRequests: 'native', inputTokens: 'preflight-conservative', generatedTokens: 'native',
      },
    });
    expect(fake.calls[0].opts.systemPromptAppend).toBeUndefined();
    const db = new DatabaseSync(ledgerPath);
    expect(db.prepare('SELECT reserved_generated_tokens, actual_total_tokens FROM bounded_reservations').get())
      .toEqual({ reserved_generated_tokens: 8_000, actual_total_tokens: 15 });
    expect(ledger.recent(1)[0].fence).toBe('fenced');
    db.close();
  });

  it('refuses explicit packs before the provider is called', async () => {
    const fake = fakeGlm();
    const outcome = await dispatch(
      boundedRequest(tempDir(), { skills: ['worker-role'] }), tempLedger(), () => fake.adapter,
    );
    expect(outcome.refusal?.code).toBe('bounded-forbidden-tools');
    expect(outcome.refusal?.reason).toContain('packs');
    expect(fake.calls).toHaveLength(0);
  });

  it('retains over-byte JSON but never admits it as a valid result', async () => {
    const output = JSON.stringify({ finding: 'x'.repeat(16_000) });
    const fake = fakeGlm({ ok: true, output, exitCode: null, usage: { inputTokens: 10, outputTokens: 100 } });
    const outcome = await dispatch(boundedRequest(tempDir()), tempLedger(), () => fake.adapter);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toBe(output);
    expect(outcome.incomplete).toBe(true);
    expect(outcome.boundedReceipt).toBeDefined();
    expect(outcome.boundedReceipt!.status).toBe('incomplete');
  });
});
