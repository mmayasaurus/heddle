import { describe, expect, it, vi } from 'vitest';
const { secureReadFileMock } = vi.hoisted(() => ({
  secureReadFileMock: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));
vi.mock('../../src/secure-fs.js', () => ({ secureReadFile: secureReadFileMock }));
import { defaultAdapterFor } from '../../src/dispatch.js';
import { LocalAdapter } from '../../src/adapters/local.js';
import { isInProcessHttpProvider } from '../../src/adapters/openai-compat.js';
import { loadRouting } from '../../src/routing.js';

const opts = { model: 'requested-model', cwd: '/tmp' };
const baseUrl = 'http://local.test/v1';
const modelsResponse = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data }) });
const completionResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }),
});

function adapter(fetchImpl: ReturnType<typeof vi.fn>, pressureLevel = 0): LocalAdapter {
  return new LocalAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, pressureLevel: () => pressureLevel, baseUrl });
}

describe('LocalAdapter', () => {
  it('resolves a loaded model and returns its completion receipt without requiring secrets', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'loaded-model', quantization: 'Q4_K_M', hash: 'abc123' }]))
      .mockResolvedValueOnce(completionResponse('done'));

    const result = await adapter(fetchImpl).dispatch('hello', opts);

    expect(result).toMatchObject({
      ok: true,
      output: 'done',
      exitCode: null,
      usage: { inputTokens: 3, outputTokens: 5 },
      raw: { model: 'loaded-model', modelInfo: { id: 'loaded-model', quantization: 'Q4_K_M', hash: 'abc123' } },
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ model: 'loaded-model', temperature: 0 });
  });

  it('declines under RAM pressure without contacting LM Studio', async () => {
    const fetchImpl = vi.fn();

    await expect(adapter(fetchImpl, 2).dispatch('hello', opts)).resolves.toMatchObject({
      ok: false,
      output: '',
      exitCode: null,
      error: 'local: ram-pressure level 2 >= 2, declined',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declines cleanly when LM Studio model discovery is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(adapter(fetchImpl).dispatch('hello', opts)).resolves.toMatchObject({
      ok: false,
      output: '',
      exitCode: null,
      error: `local: LM Studio not reachable at ${baseUrl} (/v1/models)`,
    });
  });

  it('uses the requested loaded model or falls back to the first loaded model', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'first' }, { id: 'requested-model' }]))
      .mockResolvedValueOnce(completionResponse('fallback'))
      .mockResolvedValueOnce(modelsResponse([{ id: 'first' }, { id: 'requested-model' }]))
      .mockResolvedValueOnce(completionResponse('requested'));
    const local = adapter(fetchImpl);

    await local.dispatch('hello', { ...opts, model: 'not-loaded' });
    await local.dispatch('hello', opts);

    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe('first');
    expect(JSON.parse(fetchImpl.mock.calls[3][1].body).model).toBe('requested-model');
  });

  it('retries malformed structured output once and returns validated JSON', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'loaded-model' }]))
      .mockResolvedValueOnce(completionResponse('not json'))
      .mockResolvedValueOnce(completionResponse('{"answer":"done"}'));
    const responseSchema = {
      name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    };

    await expect(adapter(fetchImpl).dispatch('hello', { ...opts, responseSchema })).resolves.toMatchObject({ ok: true, output: '{"answer":"done"}' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).response_format).toEqual({ type: 'json_schema', json_schema: responseSchema });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).messages[0].content).toContain('valid JSON');
  });

  it('returns the second raw response when structured output remains invalid', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'loaded-model' }]))
      .mockResolvedValueOnce(completionResponse('still not json'))
      .mockResolvedValueOnce(completionResponse('also not json'));
    const responseSchema = { name: 'answer', schema: { type: 'object' } };

    await expect(adapter(fetchImpl).dispatch('hello', { ...opts, responseSchema })).resolves.toMatchObject({
      ok: false,
      output: 'also not json',
      exitCode: null,
      error: 'local: structured response was not valid JSON/schema after retry',
      raw: expect.objectContaining({ response: expect.any(Object) }),
    });
  });

  it('is constructible by the default factory without a secrets key', () => {
    expect(defaultAdapterFor('local')).toBeInstanceOf(LocalAdapter);
  });

  it('ignores an insecure secrets-file local base URL and uses the default URL', async () => {
    const originalBaseUrl = process.env.HEDDLE_LOCAL_BASE_URL;
    delete process.env.HEDDLE_LOCAL_BASE_URL;
    secureReadFileMock.mockImplementation(() => {
      throw new Error('refusing to read secret file /x: group or other permissions are present');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(modelsResponse([{ id: 'loaded-model' }]))
        .mockResolvedValueOnce(completionResponse('done'));

      await new LocalAdapter({ fetchImpl, pressureLevel: () => 0 }).dispatch('hello', opts);

      expect(fetchImpl.mock.calls[0][0]).toMatch(/^http:\/\/localhost:1234\/v1/);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('local: ignoring HEDDLE_LOCAL_BASE_URL from secrets.env'));
    } finally {
      secureReadFileMock.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
      if (originalBaseUrl === undefined) delete process.env.HEDDLE_LOCAL_BASE_URL;
      else process.env.HEDDLE_LOCAL_BASE_URL = originalBaseUrl;
      vi.restoreAllMocks();
    }
  });

  it('leaves local unreferenced by all configured lane and task routes', () => {
    const routing = loadRouting(new URL('../../routing/routing.v0.yaml', import.meta.url).pathname);

    expect(routing.providers.local).toMatchObject({ base_url: 'http://localhost:1234/v1' });
    expect(JSON.stringify(routing.laneDefaults)).not.toContain('"local"');
    expect(JSON.stringify(routing.taskClasses)).not.toContain('"local"');
  });

  it('is classified as an in-process HTTP provider so the dispatcher embeds packs+diff', () => {
    expect(isInProcessHttpProvider('local')).toBe(true);
    expect(isInProcessHttpProvider('glm')).toBe(true);
    expect(isInProcessHttpProvider('codex')).toBe(false);
  });

  it('rejects structured output that violates a declared string constraint (minLength)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(modelsResponse([{ id: 'loaded-model' }]))
      .mockResolvedValueOnce(completionResponse('{"answer":"hi"}'))
      .mockResolvedValueOnce(completionResponse('{"answer":"no"}'));
    const responseSchema = {
      name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string', minLength: 5 } }, required: ['answer'] },
    };
    await expect(adapter(fetchImpl).dispatch('hello', { ...opts, responseSchema })).resolves.toMatchObject({
      ok: false,
      error: 'local: structured response was not valid JSON/schema after retry',
    });
  });
});
