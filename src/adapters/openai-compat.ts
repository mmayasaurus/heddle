import { homedir } from 'node:os';
import { join } from 'node:path';
import { secureReadFile } from '../secure-fs.js';
import { escapeControlChars } from '../control-escape.js';
import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../types.js';

export const DEFAULT_SECRETS_PATH = join(homedir(), '.heddle', 'secrets.env');

/**
 * A credential-reader refusal is security-significant, unlike an absent key or a provider error.
 * Keep this discriminator at the adapter boundary: secure-fs owns the filesystem checks, while
 * dispatch needs a stable, typed signal to avoid treating that refusal as a fallback candidate.
 */
export class InsecureCredentialFileError extends Error {
  readonly file: string;

  constructor(file: string, cause: unknown) {
    // The cause (secure-fs) message already names the file and the specific reason ("refusing to read
    // secret file <path>: <reason>"), so this wrapper does NOT re-prefix the path — duplicating it only
    // bloats the message and can push the reason past a downstream detail-length cap (probe.ts's sanitize
    // slices doctor/freshness details to 240 chars, and two absolute temp paths overrun it). The path
    // stays available programmatically via `this.file`.
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'InsecureCredentialFileError';
    this.file = file;
  }
}

/** Read one key from heddle’s secrets file; adapter credentials never come from process.env. */
export function readSecretsEnvValue(keyEnv: string, path = DEFAULT_SECRETS_PATH): string | undefined {
  let contents: string;
  try {
    contents = secureReadFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // absent file → key not configured (benign)
    // secureReadFile's non-ENOENT failures are its refusal-to-read contract (symlink, ownership,
    // permissions, or another unsafe-open condition). Preserve the cause for diagnostics while
    // giving dispatch a typed security discriminator without changing secure-fs itself.
    throw new InsecureCredentialFileError(path, err);
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] === keyEnv && match[2]) {
      const raw = match[2];
      const quoted = raw.match(/^(['"])(.*?)\1/);
      const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
      return value || undefined;
    }
  }
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
export const PROVIDER_REGISTRY: Record<'groq' | 'cerebras' | 'openrouter' | 'glm', OpenAICompatProvider> = {
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
  glm: {
    // Z.ai Coding Plan keys are valid only here — NEVER use the general /api/paas/v4 endpoint.
    baseUrl: 'https://api.z.ai/api/coding/paas/v4', keyEnv: 'ZAI_API_KEY',
    models: { 'glm-5.3': 'glm-5.3', 'glm-5.3-flash': 'glm-5.3-flash', workhorse: 'glm-5.3' }, tokenParam: 'max_completion_tokens',
    maxTokensDefault: 32768, qualityTier: 'workhorse', lastVerified: '2026-09-05',
  },
};

/** True for the static OpenAI-compat registry providers (groq / cerebras / openrouter / glm). */
export function isOpenAICompatProvider(provider: string): provider is 'groq' | 'cerebras' | 'openrouter' | 'glm' {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, provider);
}

/**
 * True for every in-process HTTP provider (no filesystem/shell): the OpenAI-compat registry plus the
 * local LM Studio adapter. The dispatcher must EMBED packs + diff for these (they cannot run git or read
 * a materialized AGENTS.md), so this — not `isOpenAICompatProvider` — is the correct `isHttp` test.
 */
export function isInProcessHttpProvider(provider: string): boolean {
  return isOpenAICompatProvider(provider) || provider === 'local';
}

export interface ChatResponse {
  id?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

type OpenAICompatProviderName = 'groq' | 'cerebras' | 'openrouter' | 'glm';

/** Pure request construction shared by admission and the admitted adapter instance. */
export function buildOpenAICompatRequest(
  provider: OpenAICompatProviderName,
  prompt: string,
  opts: DispatchOptions,
  apiKey: string,
  requested = PROVIDER_REGISTRY[provider].maxTokensDefault,
): { url: string; headers: Record<string, string>; body: string } {
  const config = PROVIDER_REGISTRY[provider];
  const budget = config.contextCap ? Math.min(requested, config.contextCap) : requested;
  const model = config.models[opts.model] ?? opts.model;
  const messages = opts.systemPromptAppend
    ? [{ role: 'system', content: opts.systemPromptAppend }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, [config.tokenParam]: budget }),
  };
}

/**
 * Conservative preflight bound for the exact in-process request body. Every tokenizer token consumes
 * at least one UTF-8 byte from this fully assembled body, so byte length may over-reserve but can
 * never treat unknown message/system/pack overhead as zero.
 */
export function openAICompatInputTokenUpperBound(
  provider: OpenAICompatProviderName,
  prompt: string,
  opts: DispatchOptions,
): number {
  return Buffer.byteLength(buildOpenAICompatRequest(
    provider, prompt, opts, '', opts.maxOutputTokens ?? PROVIDER_REGISTRY[provider].maxTokensDefault,
  ).body, 'utf8');
}

/** Generic HTTP worker for OpenAI Chat Completions-compatible providers. */
export class OpenAICompatAdapter implements WorkerAdapter {
  readonly name: string;
  readonly provider: OpenAICompatProviderName;
  private readonly config: OpenAICompatProvider;

  constructor(provider: OpenAICompatProviderName) {
    this.name = provider;
    this.provider = provider;
    this.config = PROVIDER_REGISTRY[provider];
  }

  /** Pure request construction; apiKey is supplied by dispatch after loading the secrets file. */
  buildRequest(prompt: string, opts: DispatchOptions, apiKey: string, requested = this.config.maxTokensDefault): {
    url: string; headers: Record<string, string>; body: string;
  } {
    return buildOpenAICompatRequest(this.provider, prompt, opts, apiKey, requested);
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const started = Date.now();
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const completed = (result: WorkerResult): WorkerResult => ({ ...result, durationMs: Date.now() - started });
    let apiKey: string | undefined;
    try {
      apiKey = this.loadKey();
    } catch (err) {
      const securityRefusal = err instanceof InsecureCredentialFileError
        ? { code: 'insecure-credential-file' as const, file: err.file }
        : undefined;
      // InsecureCredentialFileError.message is the secure-fs reason itself ("refusing to read secret file
      // <path>: <reason>"), which already names the file — so for that typed case the provider tag alone is
      // enough and the "refusing to use ~/.heddle/secrets.env" preamble would just repeat it (codacy #239 LOW).
      // Other errors keep the explicit preamble. Both branches run through escapeControlChars so a control
      // char in the (HOME-derived) path or reason cannot inject into the returned outcome, the ledger, or a
      // terminal (qodo #239 log-injection HIGH); escaping at this source keeps every downstream sink clean.
      const detail = err instanceof InsecureCredentialFileError
        ? `${this.provider}: ${err.message}`
        : `${this.provider}: refusing to use ~/.heddle/secrets.env — ${err instanceof Error ? err.message : String(err)}`;
      return completed({
        ok: false, output: '', exitCode: null,
        error: escapeControlChars(detail),
        ...(securityRefusal ? { securityRefusal } : {}),
      });
    }
    if (!apiKey) return completed(this.keyMissingResult());

    const firstBudget = opts.maxOutputTokens ?? this.config.maxTokensDefault;
    const first = await this.request(prompt, opts, apiKey, firstBudget, deadline);
    if ('result' in first) return completed(first.result);
    const firstResult = toResult(first.response, first.httpOk);
    if (opts.allowReasoningRetry === false || opts.maxModelRequests === 1
        || !this.needsReasoningRetry(first.response) || Date.now() >= deadline) return completed(firstResult);

    const enforcedFirstBudget = this.budgetFor(firstBudget);
    const retryBudget = Math.min(firstBudget * 2, this.config.contextCap ?? Infinity);
    if (retryBudget === enforcedFirstBudget) return completed(firstResult);
    const retry = await this.request(prompt, opts, apiKey, retryBudget, deadline);
    if ('result' in retry) return completed({ ...retry.result, usage: sumUsage(firstResult.usage, retry.result.usage) });
    const result = toResult(retry.response, retry.httpOk);
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
        if (opts.maxOutputBytes !== undefined && response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const remaining = opts.maxOutputBytes - bytes;
            if (next.value.byteLength > remaining) {
              if (remaining > 0) chunks.push(next.value.slice(0, remaining));
              bytes += Math.max(0, remaining);
              await reader.cancel('bounded response byte cap exceeded');
              controller.abort();
              let partial = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
              while (Buffer.byteLength(partial, 'utf8') > opts.maxOutputBytes) partial = partial.slice(0, -1);
              return { result: {
                ok: false, output: partial, exitCode: null, incomplete: true, remoteOutcome: 'unknown',
                error: `${this.provider}: HTTP ${response.status}; response exceeded the ${opts.maxOutputBytes}-byte bounded transport cap`,
              } };
            }
            chunks.push(next.value);
            bytes += next.value.byteLength;
          }
          const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
          body = JSON.parse(text) as ChatResponse;
        } else {
          body = await response.json() as ChatResponse;
        }
      } catch (err) {
        if (controller.signal.aborted) throw err;
        return { result: { ok: false, output: '', exitCode: null, error: `${this.provider}: invalid JSON response (HTTP ${response.status})` } };
      }
      if (!response.ok) return { result: { ok: false, output: '', exitCode: null, error: `${this.provider}: HTTP ${response.status}`, raw: body } };
      return { response: body, httpOk: response.ok };
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return { result: {
        ok: false, output: '', exitCode: null,
        error: timedOut ? `${this.provider}: request timed out` : `${this.provider}: request failed: ${err instanceof Error ? err.message : String(err)}`,
        ...(timedOut ? { incomplete: true as const, remoteOutcome: 'unknown' as const } : {}),
      } };
    } finally {
      clearTimeout(timeout);
    }
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

export function toResult(response: ChatResponse, httpOk: boolean): WorkerResult {
  const choice = response.choices?.[0];
  const output = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const truncated = choice?.finish_reason === 'length';
  const usage: TokenUsage | undefined = response.usage ? {
    requestId: response.id,
    inputTokens: response.usage.prompt_tokens,
    cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
    cacheCreationInputTokens: response.usage.prompt_tokens_details?.cache_creation_tokens,
    outputTokens: response.usage.completion_tokens,
    reasoningOutputTokens: response.usage.completion_tokens_details?.reasoning_tokens,
  } : undefined;
  return {
    ok: httpOk && output.length > 0 && !truncated,
    output,
    usage,
    exitCode: null,
    error: truncated ? 'length-limited response' : output.length ? undefined : 'empty content',
    raw: response,
    ...(truncated ? { incomplete: true as const, truncated: true as const } : {}),
  };
}

export function sumUsage(first?: TokenUsage, second?: TokenUsage): TokenUsage | undefined {
  const sum = (a?: number, b?: number): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const usage = {
    inputTokens: sum(first?.inputTokens, second?.inputTokens),
    cachedInputTokens: sum(first?.cachedInputTokens, second?.cachedInputTokens),
    cacheCreationInputTokens: sum(first?.cacheCreationInputTokens, second?.cacheCreationInputTokens),
    outputTokens: sum(first?.outputTokens, second?.outputTokens),
    reasoningOutputTokens: sum(first?.reasoningOutputTokens, second?.reasoningOutputTokens),
  };
  return usage.inputTokens === undefined && usage.cachedInputTokens === undefined
    && usage.cacheCreationInputTokens === undefined && usage.outputTokens === undefined
    && usage.reasoningOutputTokens === undefined ? undefined : usage;
}
