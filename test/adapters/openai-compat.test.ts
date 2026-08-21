import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
import { readFileSync } from 'node:fs';
import { OpenAICompatAdapter } from '../../src/adapters/openai-compat.js';

const opts = { model: 'openai/gpt-oss-120b', cwd: '/tmp' };
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe('OpenAICompatAdapter', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('builds OpenAI chat-completions requests for each configured provider', () => {
    const groq = new OpenAICompatAdapter('groq').buildRequest('hello', opts, 'groq-key');
    expect(groq).toEqual({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { Authorization: 'Bearer groq-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32768 }),
    });
    const cerebras = new OpenAICompatAdapter('cerebras').buildRequest('hello', opts, 'cerebras-key');
    expect(cerebras.url).toBe('https://api.cerebras.ai/v1/chat/completions');
    const openrouter = new OpenAICompatAdapter('openrouter').buildRequest('hello', { ...opts, model: 'dynamic/provider-model' }, 'router-key');
    expect(JSON.parse(openrouter.body).model).toBe('dynamic/provider-model');
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
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 3, completion_tokens: 32768, completion_tokens_details: { reasoning_tokens: 32768 } } }))
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: 'after retry' } }], usage: { prompt_tokens: 3, completion_tokens: 7 } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new OpenAICompatAdapter('groq').dispatch('hello', opts)).resolves.toMatchObject({ ok: true, output: 'after retry' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).max_tokens).toBe(65536);
  });

  it('fails loudly when its key is missing', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(new OpenAICompatAdapter('cerebras').dispatch('hello', opts)).resolves.toEqual({
      ok: false, output: '', exitCode: null,
      error: 'cerebras: CEREBRAS_API_KEY not found in ~/.heddle/secrets.env',
    });
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
});
