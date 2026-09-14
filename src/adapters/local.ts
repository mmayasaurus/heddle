import { execFileSync } from 'node:child_process';
import { readSecretsEnvValue, sumUsage, toResult, type ChatResponse } from './openai-compat.js';
import type { DispatchOptions, ResponseSchema, WorkerAdapter, WorkerResult } from '../types.js';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const STRUCTURED_OUTPUT_REMINDER = 'Return only valid JSON that conforms to the requested response schema.';

export interface LocalAdapterDeps {
  fetchImpl?: typeof fetch;
  pressureLevel?: () => number;
  baseUrl?: string;
}

interface LocalModel {
  id: string;
  [key: string]: unknown;
}

export class LocalAdapter implements WorkerAdapter {
  readonly name = 'local';
  readonly provider = 'local' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly pressureLevel: () => number;
  private readonly baseUrl: string;

  constructor(deps: LocalAdapterDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.pressureLevel = deps.pressureLevel ?? readPressureLevel;
    this.baseUrl = normalizeBaseUrl(deps.baseUrl ?? process.env.HEDDLE_LOCAL_BASE_URL ?? readSecretsEnvValue('HEDDLE_LOCAL_BASE_URL') ?? DEFAULT_BASE_URL);
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const started = Date.now();
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const completed = (result: WorkerResult): WorkerResult => ({ ...result, durationMs: Date.now() - started });
    const pressure = this.currentPressureLevel();
    if (pressure >= 2) {
      return completed({ ok: false, output: '', exitCode: null, error: `local: ram-pressure level ${pressure} >= 2, declined` });
    }

    const modelInfo = await this.findLoadedModel(opts.model, deadline);
    if (!modelInfo) {
      return completed({ ok: false, output: '', exitCode: null, error: `local: LM Studio not reachable at ${this.baseUrl} (/v1/models)` });
    }

    const first = await this.request(prompt, opts, modelInfo.id, deadline);
    if ('result' in first) return completed(this.withReceipt(first.result, modelInfo));
    const firstResult = this.withReceipt(toResult(first.response, first.httpOk), modelInfo);
    if (!opts.responseSchema || isStructuredOutputValid(firstResult.output, opts.responseSchema)) return completed(firstResult);

    const retry = await this.request(prompt, opts, modelInfo.id, deadline, STRUCTURED_OUTPUT_REMINDER);
    if ('result' in retry) return completed(this.withReceipt({ ...retry.result, usage: sumUsage(firstResult.usage, retry.result.usage) }, modelInfo));
    const retryResult = this.withReceipt(toResult(retry.response, retry.httpOk), modelInfo);
    const usage = sumUsage(firstResult.usage, retryResult.usage);
    if (retryResult.ok && isStructuredOutputValid(retryResult.output, opts.responseSchema)) {
      return completed({ ...retryResult, usage });
    }
    return completed({
      ...retryResult,
      ok: false,
      usage,
      error: 'local: structured response was not valid JSON/schema after retry',
    });
  }

  private currentPressureLevel(): number {
    try {
      const level = this.pressureLevel();
      return Number.isFinite(level) && level >= 0 ? Math.floor(level) : 0;
    } catch {
      return 0;
    }
  }

  private async findLoadedModel(requested: string, deadline: number): Promise<LocalModel | undefined> {
    const response = await this.fetchJson(`${this.baseUrl}/models`, { method: 'GET' }, deadline);
    if (!response?.ok || !isRecord(response.body) || !Array.isArray(response.body.data)) return undefined;
    const models = response.body.data.filter(isLocalModel);
    if (models.length === 0) return undefined;
    return models.find((model) => model.id === requested) ?? models[0];
  }

  private async request(prompt: string, opts: DispatchOptions, model: string, deadline: number, reminder?: string): Promise<
    { response: ChatResponse; httpOk: boolean } | { result: WorkerResult }
  > {
    const messages = [
      ...(opts.systemPromptAppend ? [{ role: 'system', content: opts.systemPromptAppend }] : []),
      ...(reminder ? [{ role: 'system', content: reminder }] : []),
      { role: 'user', content: prompt },
    ];
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0,
      ...(opts.responseSchema ? { response_format: { type: 'json_schema', json_schema: opts.responseSchema } } : {}),
    });
    const fetched = await this.fetchJson(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, deadline);
    if (!fetched) return { result: { ok: false, output: '', exitCode: null, error: 'local: request failed' } };
    if (!isRecord(fetched.body)) return { result: { ok: false, output: '', exitCode: null, error: `local: invalid JSON response (HTTP ${fetched.status})` } };
    const response = fetched.body as ChatResponse;
    if (!fetched.ok) return { result: { ok: false, output: '', exitCode: null, error: `local: HTTP ${fetched.status}`, raw: response } };
    return { response, httpOk: fetched.ok };
  }

  private async fetchJson(url: string, init: RequestInit, deadline: number): Promise<{ ok: boolean; status: number; body: unknown } | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      try {
        return { ok: response.ok, status: response.status, body: await response.json() };
      } catch {
        return { ok: response.ok, status: response.status, body: undefined };
      }
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private withReceipt(result: WorkerResult, modelInfo: LocalModel): WorkerResult {
    return { ...result, raw: { model: modelInfo.id, modelInfo, response: result.raw } };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function readPressureLevel(): number {
  try {
    const stdout = execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const level = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(level) ? level : 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalModel(value: unknown): value is LocalModel {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

function isStructuredOutputValid(output: string, responseSchema: ResponseSchema): boolean {
  try {
    return matchesJsonSchema(JSON.parse(output), responseSchema.schema);
  } catch {
    return false;
  }
}

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => isRecord(entry) && matchesJsonSchema(value, entry))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => isRecord(entry) && matchesJsonSchema(value, entry))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((entry) => isRecord(entry) && matchesJsonSchema(value, entry)).length !== 1) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => value === entry)) return false;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types[0] !== undefined && !types.some((type) => matchesType(value, type))) return false;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    return !isRecord(itemSchema) || value.every((entry) => matchesJsonSchema(entry, itemSchema));
  }
  if (!isRecord(value)) return true;

  if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(value, key))) return false;
  if (isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && isRecord(propertySchema) && !matchesJsonSchema(value[key], propertySchema)) return false;
    }
  }
  if (schema.additionalProperties === false && isRecord(schema.properties)) {
    return Object.keys(value).every((key) => Object.hasOwn(schema.properties!, key));
  }
  return true;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}
