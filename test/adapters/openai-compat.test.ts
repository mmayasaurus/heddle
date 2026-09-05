import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
import { readFileSync } from 'node:fs';
import { OpenAICompatAdapter } from '../../src/adapters/openai-compat.js';

const opts = { model: 'openai/gpt-oss-120b', cwd: '/tmp' };
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe('OpenAICompatAdapter', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('builds OpenAI chat-completions requests for each configured provider', () => {
    const groq = new OpenAICompatAdapter('groq').buildRequest('hello', opts, 'groq-key');
    expect(groq).toEqual({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { Authorization: 'Bearer groq-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 32768 }),
    });
    const cerebras = new OpenAICompatAdapter('cerebras').buildRequest('hello', opts, 'cerebras-key');
    expect(cerebras.url).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect(JSON.parse(cerebras.body).max_completion_tokens).toBeLessThanOrEqual(8192);
    const packed = new OpenAICompatAdapter('groq').buildRequest('hello', { ...opts, systemPromptAppend: 'worker-role' }, 'groq-key');
    expect(JSON.parse(packed.body).messages).toEqual([{ role: 'system', content: 'worker-role' }, { role: 'user', content: 'hello' }]);
    const alias = new OpenAICompatAdapter('groq').buildRequest('hello', { ...opts, model: 'workhorse' }, 'groq-key');
    expect(JSON.parse(alias.body).model).toBe('openai/gpt-oss-120b');
    const openrouter = new OpenAICompatAdapter('openrouter').buildRequest('hello', { ...opts, model: 'dynamic/provider-model' }, 'router-key');
    expect(JSON.parse(openrouter.body).model).toBe('dynamic/provider-model');
    const glm = new OpenAICompatAdapter('glm').buildRequest('hello', { ...opts, model: 'workhorse' }, 'glm-key');
    expect(glm).toEqual({
      url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      headers: { Authorization: 'Bearer glm-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 32768 }),
    });
  });

  it('maps a chat completion to WorkerResult', async () => {
    vi.mocked(readFileSync).mockReturnValue('GROQ_API_KEY=secret\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } })));
    await expect(new OpenAICompatAdapter('groq').dispatch('hello', opts)).resolves.toMatchObject({
      ok: true, output: 'done', exitCode: null,
      usage: { inputTokens: 3, outputTokens: 5, reasoningOutputTokens: 2 },
    });
  });

  it('retries empty reasoning content once with a larger token budget', async () => {
    vi.mocked(readFileSync).mockReturnValue('GROQ_API_KEY=secret\n');
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 3, completion_tokens: 32768, completion_tokens_details: { reasoning_tokens: 4 } } }))
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: 'after retry' } }], usage: { prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new OpenAICompatAdapter('groq').dispatch('hello', opts)).resolves.toMatchObject({
      ok: true, output: 'after retry', usage: { inputTokens: 8, outputTokens: 32775, reasoningOutputTokens: 6 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).max_completion_tokens).toBe(65536);
  });

  it('fails loudly when its key is missing', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(new OpenAICompatAdapter('cerebras').dispatch('hello', opts)).resolves.toMatchObject({
      ok: false, output: '', exitCode: null,
      error: 'cerebras: CEREBRAS_API_KEY not found in ~/.heddle/secrets.env',
      durationMs: expect.any(Number),
    });
  });

  it('trims a quoted secret value before using it in the authorization header', async () => {
    vi.mocked(readFileSync).mockReturnValue('GROQ_API_KEY="secret"  \n');
    const fetch = vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatAdapter('groq').dispatch('hello', opts);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });

  it('returns a failure for an aborted request', async () => {
    vi.mocked(readFileSync).mockReturnValue('OPENROUTER_API_KEY=secret\n');
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    await expect(new OpenAICompatAdapter('openrouter').dispatch('hello', { ...opts, model: 'dynamic/model', timeoutMs: 1 })).resolves.toMatchObject({
      ok: false, output: '', exitCode: null, error: expect.stringContaining('timed out'),
    });
  });

  it('does not start a reasoning retry after the shared deadline expires', async () => {
    vi.mocked(readFileSync).mockReturnValue('GROQ_API_KEY=secret\n');
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10);
    const fetch = vi.fn().mockResolvedValue(response({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(new OpenAICompatAdapter('groq').dispatch('hello', { ...opts, timeoutMs: 10 })).resolves.toMatchObject({ ok: false, output: '' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
