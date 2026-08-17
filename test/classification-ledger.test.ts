import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../src/adapters/codex.js', () => ({
  CodexAdapter: class {
    dispatch = dispatch;
  },
}));

import { classify } from '../src/classify.js';

function workerDispatch(ledger: Ledger, inputTokens = 40): void {
  const id = ledger.start({
    orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: null, issue: null, pr: null, cwd: '/tmp/heddle-test', promptPreview: 'implement it',
    sessionId: null, fellBackFrom: null,
  });
  ledger.finish(id, { ok: true, inputTokens, outputTokens: 4 });
}

function classification(ledger: Ledger, over: Partial<Parameters<Ledger['recordClassification']>[0]> = {}): number {
  return ledger.recordClassification({
    orchestrator: 'U', identitySource: 'caller', kind: 'classify-effort', provider: 'codex',
    model: 'gpt-5.6-luna', cwd: '/tmp/heddle-test', promptPreview: 'classify this task', ok: true,
    inputTokens: 10, outputTokens: 1, ...over,
  });
}

describe('classification ledger rows (temp db)', () => {
  const { tempLedger } = useTempResources('heddle-classification-ledger-test-');
  let ledger: Ledger;

  beforeEach(() => {
    ledger = tempLedger();
    dispatch.mockResolvedValue({ ok: true, output: 'minimal', exitCode: 0, usage: { inputTokens: 7, outputTokens: 2 } });
  });

  it('1. records a finished classification row', () => {
    const id = classification(ledger, { inputTokens: 100, outputTokens: 5 });

    expect(ledger.get(id)).toMatchObject({
      execution_mode: 'classification', task_class: 'classify-effort', ok: 1,
    });
    expect(ledger.get(id)?.started_at).toEqual(expect.any(String));
    expect(ledger.get(id)?.finished_at).toEqual(expect.any(String));
  });

  it('2. excludes classifications from worker-provider usage', () => {
    workerDispatch(ledger, 40);
    classification(ledger, { inputTokens: 100 });
    classification(ledger, { inputTokens: 200 });

    expect(ledger.usageByProvider().find((row) => row.provider === 'codex')).toMatchObject({
      dispatches: 1, input_tokens: 40,
    });
  });

  it('3. still counts an ordinary start-and-finish row in worker-provider usage', () => {
    workerDispatch(ledger, 40);

    expect(ledger.usageByProvider().find((row) => row.provider === 'codex')).toMatchObject({
      dispatches: 1, input_tokens: 40,
    });
  });

  it('4. reports only classifier rows grouped by provider, model, and kind', () => {
    classification(ledger, { inputTokens: 10, outputTokens: 1 });
    classification(ledger, { inputTokens: 20, outputTokens: 2 });
    classification(ledger, {
      kind: 'assess-result', model: 'gpt-5.6-terra', inputTokens: 30, outputTokens: 3,
    });
    workerDispatch(ledger, 400);

    const usage = ledger.classificationUsage();
    expect(usage).toHaveLength(2);
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex', model: 'gpt-5.6-luna', kind: 'classify-effort',
        runs: 2, input_tokens: 30, output_tokens: 3,
      }),
      expect.objectContaining({
        provider: 'codex', model: 'gpt-5.6-terra', kind: 'assess-result',
        runs: 1, input_tokens: 30, output_tokens: 3,
      }),
    ]));
  });

  it('5. applies sinceIso filtering to worker and classification usage', () => {
    workerDispatch(ledger);
    classification(ledger);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    expect(ledger.usageByProvider(future)).toEqual([]);
    expect(ledger.classificationUsage(future)).toEqual([]);
  });

  it('6. does not count already-finished classifications as in flight', () => {
    const before = ledger.inFlightCount('U', 60_000);
    classification(ledger);
    classification(ledger);
    classification(ledger);

    expect(ledger.inFlightCount('U', 60_000)).toBe(before);
  });

  it('7. records classify through its injected ledger without a real Codex process', async () => {
    const result = await classify(
      'Choose the effort.', ['minimal', 'high'], '/tmp/heddle-test',
      { provider: 'codex', model: 'test-classifier' }, 1_000, 'classify-effort', ledger,
    );

    expect(result).toMatchObject({ label: 'minimal', matched: true });
    expect(dispatch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      model: 'test-classifier', cwd: '/tmp/heddle-test', timeoutMs: 1_000,
    }));
    expect(ledger.classificationUsage()).toEqual([expect.objectContaining({
      provider: 'codex', model: 'test-classifier', kind: 'classify-effort', runs: 1,
      input_tokens: 7, output_tokens: 2,
    })]);
  });

  it('8. continues returning the label when classification ledgering fails', async () => {
    const failingLedger = {
      recordClassification: () => { throw new Error('ledger unavailable'); },
    } as unknown as Ledger;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await classify(
      'Choose the effort.', ['minimal', 'high'], '/tmp/heddle-test',
      { provider: 'codex', model: 'test-classifier' }, 1_000, 'classify-effort', failingLedger,
    );

    expect(result).toMatchObject({ label: 'minimal', matched: true });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not ledger the classify-effort classification'));
  });
});
