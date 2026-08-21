import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../types.js';

export interface OpenAICompatProvider {
  baseUrl: string;
  keyEnv: string;
  /** Static providers map their accepted aliases to API model ids; OpenRouter is intentionally empty. */
  models: Record<string, string>;
  contextCap?: number;
  maxTokensDefault: number;
  qualityTier: string;
  lastVerified: string;
}

/** Configuration-only provider registry. OpenRouter model ids are selected dynamically by the caller. */
export const PROVIDER_REGISTRY: Record<'groq' | 'cerebras' | 'openrouter', OpenAICompatProvider> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY',
    models: { 'openai/gpt-oss-120b': 'openai/gpt-oss-120b', 'gpt-oss-20b': 'gpt-oss-20b', 'qwen3.6-27b': 'qwen3.6-27b' },
    maxTokensDefault: 32768, qualityTier: 'workhorse', lastVerified: '2026-08-20',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY',
    models: { 'gpt-oss-120b': 'gpt-oss-120b', 'gemma-4-31b': 'gemma-4-31b' }, contextCap: 8192,
    maxTokensDefault: 32768, qualityTier: 'workhorse', lastVerified: '2026-08-20',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: {},
    maxTokensDefault: 32768, qualityTier: 'dynamic-quality-allowlist', lastVerified: '2026-08-20',
  },
};

interface ChatResponse {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/** Generic HTTP worker for OpenAI Chat Completions-compatible providers. */
export class OpenAICompatAdapter implements WorkerAdapter {
  readonly name: string;
  readonly provider: 'groq' | 'cerebras' | 'openrouter';
  private readonly config: OpenAICompatProvider;

  constructor(provider: 'groq' | 'cerebras' | 'openrouter') {
    this.name = provider;
    this.provider = provider;
    this.config = PROVIDER_REGISTRY[provider];
  }

  /** Pure request construction; apiKey is supplied by dispatch after loading the secrets file. */
  buildRequest(prompt: string, opts: DispatchOptions, apiKey: string, maxTokens = this.config.maxTokensDefault): {
    url: string; headers: Record<string, string>; body: string;
  } {
    return {
      url: `${this.config.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    };
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const apiKey = this.loadKey();
    if (!apiKey) return this.keyMissingResult();

    const first = await this.request(prompt, opts, apiKey, this.config.maxTokensDefault);
    if ('result' in first) return first.result;
    if (!this.needsReasoningRetry(first.response)) return this.toResult(first.response, first.httpOk);

    const retry = await this.request(prompt, opts, apiKey, this.config.maxTokensDefault * 2);
    if ('result' in retry) return retry.result;
    const result = this.toResult(retry.response, retry.httpOk);
    return result.output.length === 0
      ? { ...result, ok: false, error: 'empty content after reasoning-retry' }
      : result;
  }

  private loadKey(): string | undefined {
    try {
      const contents = fs.readFileSync(join(homedir(), '.heddle', 'secrets.env'), 'utf8');
      for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match?.[1] === this.config.keyEnv && match[2]) return match[2].replace(/^['"]|['"]$/g, '');
      }
    } catch {
      // The caller gets the deliberate, non-secret failure below.
    }
    return undefined;
  }

  private keyMissingResult(): WorkerResult {
    return { ok: false, output: '', exitCode: null, error: `${this.provider}: ${this.config.keyEnv} not found in ~/.heddle/secrets.env` };
  }

  private async request(prompt: string, opts: DispatchOptions, apiKey: string, maxTokens: number): Promise<
    { response: ChatResponse; httpOk: boolean } | { result: WorkerResult }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000);
    try {
      const request = this.buildRequest(prompt, opts, apiKey, maxTokens);
      const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal });
      let body: ChatResponse;
      try {
        body = await response.json() as ChatResponse;
      } catch {
        return { result: { ok: false, output: '', exitCode: null, error: `${this.provider}: invalid JSON response (HTTP ${response.status})` } };
      }
      if (!response.ok) return { result: { ok: false, output: '', exitCode: null, error: `${this.provider}: HTTP ${response.status}`, raw: body } };
      return { response: body, httpOk: response.ok };
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return { result: { ok: false, output: '', exitCode: null, error: timedOut ? `${this.provider}: request timed out` : `${this.provider}: request failed: ${err instanceof Error ? err.message : String(err)}` } };
    } finally {
      clearTimeout(timeout);
    }
  }

  private toResult(response: ChatResponse, httpOk: boolean): WorkerResult {
    const choice = response.choices?.[0];
    const output = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const usage: TokenUsage | undefined = response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      reasoningOutputTokens: response.usage.completion_tokens_details?.reasoning_tokens,
    } : undefined;
    return { ok: httpOk && output.length > 0, output, usage, exitCode: null, error: output.length ? undefined : 'empty content', raw: response };
  }

  private needsReasoningRetry(response: ChatResponse): boolean {
    const choice = response.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const usage = response.usage;
    return content.length === 0 && (choice?.finish_reason === 'length' || (usage?.completion_tokens ?? 0) > 0 || (usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0);
  }
}
