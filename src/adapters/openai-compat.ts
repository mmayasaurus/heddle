import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../types.js';

export const DEFAULT_SECRETS_PATH = join(homedir(), '.heddle', 'secrets.env');

/** Read one key from heddle’s secrets file; adapter credentials never come from process.env. */
export function readSecretsEnvValue(keyEnv: string, path = DEFAULT_SECRETS_PATH): string | undefined {
  try {
    const contents = fs.readFileSync(path, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match?.[1] === keyEnv && match[2]) {
        const raw = match[2];
        const quoted = raw.match(/^(['"])(.*?)\1/);
        const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
        return value || undefined;
      }
    }
  } catch { /* The caller returns its deliberate non-secret missing-key result. */ }
  return undefined;
}

export interface OpenAICompatProvider {
  baseUrl: string;
  keyEnv: string;
  /** Static providers map their accepted aliases to API model ids; OpenRouter is intentionally empty. */
  models: Record<string, string>;
  tokenParam: 'max_completion_tokens';
  contextCap?: number;
  maxTokensDefault: number;
  qualityTier: string;
  lastVerified: string;
}

/** Configuration-only provider registry. OpenRouter model ids are selected dynamically by the caller. */
export const PROVIDER_REGISTRY: Record<'groq' | 'cerebras' | 'openrouter', OpenAICompatProvider> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY',
    models: { workhorse: 'openai/gpt-oss-120b', 'openai/gpt-oss-120b': 'openai/gpt-oss-120b', 'gpt-oss-20b': 'gpt-oss-20b', 'qwen3.6-27b': 'qwen3.6-27b' }, tokenParam: 'max_completion_tokens',
    maxTokensDefault: 32768, qualityTier: 'workhorse', lastVerified: '2026-08-20',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY',
    models: { 'gpt-oss-120b': 'gpt-oss-120b', 'gemma-4-31b': 'gemma-4-31b' }, tokenParam: 'max_completion_tokens', contextCap: 8192,
    maxTokensDefault: 4096, qualityTier: 'workhorse', lastVerified: '2026-08-20',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: {}, tokenParam: 'max_completion_tokens',
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
  buildRequest(prompt: string, opts: DispatchOptions, apiKey: string, requested = this.config.maxTokensDefault): {
    url: string; headers: Record<string, string>; body: string;
  } {
    const budget = this.config.contextCap ? Math.min(requested, this.config.contextCap) : requested;
    const model = this.config.models[opts.model] ?? opts.model;
    const messages = opts.systemPromptAppend
      ? [{ role: 'system', content: opts.systemPromptAppend }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }];
    return {
      url: `${this.config.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, [this.config.tokenParam]: budget }),
    };
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const started = Date.now();
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const completed = (result: WorkerResult): WorkerResult => ({ ...result, durationMs: Date.now() - started });
    const apiKey = this.loadKey();
    if (!apiKey) return completed(this.keyMissingResult());

    const first = await this.request(prompt, opts, apiKey, this.config.maxTokensDefault, deadline);
    if ('result' in first) return completed(first.result);
    const firstResult = this.toResult(first.response, first.httpOk);
    if (!this.needsReasoningRetry(first.response) || Date.now() >= deadline) return completed(firstResult);

    const firstBudget = this.budgetFor(this.config.maxTokensDefault);
    const retryBudget = Math.min(this.config.maxTokensDefault * 2, this.config.contextCap ?? Infinity);
    if (retryBudget === firstBudget) return completed(firstResult);
    const retry = await this.request(prompt, opts, apiKey, retryBudget, deadline);
    if ('result' in retry) return completed({ ...retry.result, usage: sumUsage(firstResult.usage, retry.result.usage) });
    const result = this.toResult(retry.response, retry.httpOk);
    const final = result.output.length === 0
      ? { ...result, ok: false, error: 'empty content after reasoning-retry' }
      : result;
    return completed({ ...final, usage: sumUsage(firstResult.usage, final.usage) });
  }

  private loadKey(): string | undefined {
    return readSecretsEnvValue(this.config.keyEnv);
  }

  private keyMissingResult(): WorkerResult {
    return { ok: false, output: '', exitCode: null, error: `${this.provider}: ${this.config.keyEnv} not found in ~/.heddle/secrets.env` };
  }

  private async request(prompt: string, opts: DispatchOptions, apiKey: string, maxTokens: number, deadline: number): Promise<
    { response: ChatResponse; httpOk: boolean } | { result: WorkerResult }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
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
    return content.length === 0 && choice?.finish_reason === 'length';
  }

  private budgetFor(requested: number): number {
    return this.config.contextCap ? Math.min(requested, this.config.contextCap) : requested;
  }
}

function sumUsage(first?: TokenUsage, second?: TokenUsage): TokenUsage | undefined {
  const sum = (a?: number, b?: number): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const usage = {
    inputTokens: sum(first?.inputTokens, second?.inputTokens),
    outputTokens: sum(first?.outputTokens, second?.outputTokens),
    reasoningOutputTokens: sum(first?.reasoningOutputTokens, second?.reasoningOutputTokens),
  };
  return usage.inputTokens === undefined && usage.outputTokens === undefined && usage.reasoningOutputTokens === undefined ? undefined : usage;
}
