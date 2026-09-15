import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../src/types.js';
import { useTempResources } from './helpers.js';

const TASK_CLASS = 'fdl-public-source-research';
const priorRouting = process.env.HEDDLE_ROUTING;

function fakeGlm(result: WorkerResult = {
  ok: true,
  output: '{"finding":"bounded"}',
  exitCode: null,
  raw: { id: 'provider-request-1', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  usage: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, cacheCreationInputTokens: 3, requestId: 'provider-request-1' } as any,
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

function boundedRequest(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    taskClass: TASK_CLASS,
    prompt: 'analyze this packet',
    cwd,
    optIn: true,
    noFallback: true,
    boundedAdmission: admission(),
    ...overrides,
  } as any;
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
    const outcome = await dispatch(
      boundedRequest(tempDir(), { prompt: 'x'.repeat(72_001) }),
      tempLedger(), () => fake.adapter,
    );
    expect(outcome.refusal?.code).toBe('bounded-input-oversize');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a provider without native request/output enforcement before the provider is called', async () => {
    const fake = fakeGlm();
    const outcome = await dispatch(
      boundedRequest(tempDir(), { provider: 'codex', model: 'gpt-5.6-luna' }),
      tempLedger(), () => fake.adapter,
    );
    expect(outcome.refusal?.code).toBe('bounded-unsupported-bound');
    expect((outcome as any).boundedReceipt.refusedDimensions).toEqual(expect.arrayContaining(['modelRequests', 'generatedTokens']));
    expect(fake.calls).toHaveLength(0);
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
      usage: { inputTokens: 72_000, outputTokens: 8_000, reasoningOutputTokens: 2_000, cacheCreationInputTokens: 3_000 } as any,
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
    const outcome = await dispatch(boundedRequest(tempDir()), tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts).toMatchObject({
      model: 'glm-5.3', maxOutputTokens: 8_000, maxModelRequests: 1,
      allowReasoningRetry: false, timeoutMs: 150_000, readOnly: true,
    });
    expect((outcome as any).boundedReceipt).toMatchObject({
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
  });

  it('retains over-byte JSON but never admits it as a valid result', async () => {
    const output = JSON.stringify({ finding: 'x'.repeat(16_000) });
    const fake = fakeGlm({ ok: true, output, exitCode: null, usage: { inputTokens: 10, outputTokens: 100 } });
    const outcome = await dispatch(boundedRequest(tempDir()), tempLedger(), () => fake.adapter);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toBe(output);
    expect(outcome.incomplete).toBe(true);
    expect((outcome as any).boundedReceipt.status).toBe('incomplete');
  });
});
