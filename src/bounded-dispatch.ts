import { createHash } from 'node:crypto';
import { checkoutFingerprint } from './worktree.js';
import type { DispatchBounds, Route, RouteTarget, RoutingTable } from './routing.js';
import type {
  BoundedDispatchReceipt,
  DispatchRefusal,
  DispatchRequest,
} from './dispatcher/types.js';
import type { TokenUsage, WorkerResult } from './types.js';

export interface BoundedPreflightRefusal {
  refusal: DispatchRefusal;
  receipt: BoundedDispatchReceipt;
}

export interface NormalizedBoundedUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  generatedTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

const hash = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value))
  .digest('hex');

export function boundedEnforcementSupport(
  provider: string,
  model: string,
): BoundedDispatchReceipt['enforcementSupport'] {
  const glm = provider === 'glm' && model === 'glm-5.3';
  return {
    modelRequests: glm ? 'native' : 'unsupported',
    inputTokens: glm ? 'preflight-conservative' : 'unsupported',
    generatedTokens: glm ? 'native' : 'unsupported',
    totalTokens: glm ? 'atomic-ledger' : 'unsupported',
    outputBytes: glm ? 'local-validation' : 'unsupported',
    concurrency: 'atomic-ledger',
    hourlyDispatches: 'atomic-ledger',
    sessionDispatches: 'atomic-ledger',
    sessionTokens: 'atomic-ledger',
    retry: glm ? 'native' : 'unsupported',
    timeout: glm ? 'native' : 'unsupported',
  };
}

export function normalizedBoundedUsage(usage: TokenUsage | undefined): NormalizedBoundedUsage {
  const inputTokens = usage?.inputTokens ?? null;
  const generatedTokens = usage?.outputTokens ?? null;
  return {
    inputTokens,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
    generatedTokens,
    reasoningTokens: usage?.reasoningOutputTokens ?? null,
    totalTokens: inputTokens === null || generatedTokens === null ? null : inputTokens + generatedTokens,
  };
}

export function createBoundedReceipt(
  route: Route,
  target: RouteTarget,
  req: DispatchRequest,
  table: RoutingTable,
  status: BoundedDispatchReceipt['status'],
  now = new Date().toISOString(),
): BoundedDispatchReceipt {
  const checkout = checkoutFingerprint(req.cwd);
  return {
    version: 1,
    status,
    requestId: req.boundedAdmission?.requestId ?? null,
    sessionId: req.boundedAdmission?.sessionId ?? null,
    provider: target.provider,
    model: target.model,
    account: req.boundedAdmission?.account ?? null,
    repository: checkout
      ? { commit: checkout.head, dirty: checkout.entries.size > 0 }
      : { commit: null, dirty: null },
    fingerprints: {
      adapter: hash({ family: 'openai-compatible', provider: target.provider, model: target.model }),
      route: hash(route),
      lanes: hash(table.laneDefaults ?? {}),
    },
    enforcementSupport: boundedEnforcementSupport(target.provider, target.model),
    refusedDimensions: [],
    reservation: null,
    rawUsage: null,
    normalizedUsage: normalizedBoundedUsage(undefined),
    times: {
      headroomObservedAt: req.boundedAdmission?.observedAt ?? null,
      admittedAt: null,
      completedAt: status === 'refused' ? now : null,
    },
    remoteOutcome: null,
    stubs: [
      'provider-confirmed cancellation is not exposed by the current GLM HTTP API path',
      'partial streaming output capture remains a later pass; non-streaming aborts retain no unavailable bytes',
    ],
  };
}

function refused(
  route: Route,
  target: RouteTarget,
  req: DispatchRequest,
  table: RoutingTable,
  code: DispatchRefusal['code'],
  reason: string,
  refusedDimensions: string[],
): BoundedPreflightRefusal {
  const receipt = createBoundedReceipt(route, target, req, table, 'refused');
  receipt.refusedDimensions = refusedDimensions;
  return { refusal: { code, reason }, receipt };
}

export function boundedPreflight(
  route: Route,
  target: RouteTarget,
  req: DispatchRequest,
  table: RoutingTable,
  now = Date.now(),
): BoundedPreflightRefusal | null {
  const bounds = route.bounds;
  if (!bounds) return null;
  if (route.fallback) {
    return refused(route, target, req, table, 'bounded-forbidden-fallback',
      `bounded route "${route.taskClass}" declares a fallback; a second provider path is forbidden`, ['fallback']);
  }
  if (bounds.maxModelRequests !== 1 || bounds.retry || route.autoAssess || req.autoEffort) {
    return refused(route, target, req, table, 'bounded-forbidden-extra-request',
      'bounded dispatch permits exactly one provider request and forbids retry, assessment, and effort-classifier calls',
      ['modelRequests', 'retry']);
  }
  const mcp = req.mcp ?? target.mcp ?? [];
  const capabilities = [...(target.capabilities ?? []), ...(req.capabilities ?? [])];
  if (mcp.length > 0 || capabilities.length > 0) {
    return refused(route, target, req, table, 'bounded-forbidden-tools',
      'bounded FDL analysis is read-only and tool-free; MCP attachments and capabilities are forbidden',
      ['tools']);
  }
  const support = boundedEnforcementSupport(target.provider, target.model);
  const refusedDimensions = Object.entries(support)
    .filter(([, value]) => value === 'unsupported')
    .map(([dimension]) => dimension);
  if (refusedDimensions.length > 0) {
    return refused(route, target, req, table, 'bounded-unsupported-bound',
      `${target.provider}/${target.model} cannot natively enforce the bounded route's required request/output controls`,
      refusedDimensions);
  }
  const admission = req.boundedAdmission;
  if (!admission
      || !admission.requestId?.trim()
      || !admission.sessionId?.trim()
      || !admission.account?.trim()
      || !Number.isInteger(admission.remainingTokens)
      || admission.remainingTokens < 0
      || !Number.isFinite(Date.parse(admission.observedAt))) {
    return refused(route, target, req, table, 'bounded-headroom-unknown',
      'bounded dispatch requires a complete, valid account-headroom snapshot and session/request identifiers',
      ['accountHeadroom']);
  }
  const ageMs = now - Date.parse(admission.observedAt);
  if (ageMs < 0 || ageMs > bounds.maxHeadroomAgeMs) {
    return refused(route, target, req, table, 'bounded-headroom-stale',
      `account headroom is stale or future-dated (age ${ageMs}ms; maximum ${bounds.maxHeadroomAgeMs}ms)`,
      ['accountHeadroom']);
  }
  return null;
}

export function finalizeBoundedResult(
  result: WorkerResult,
  receipt: BoundedDispatchReceipt,
  bounds: DispatchBounds,
  now = new Date().toISOString(),
): WorkerResult {
  const normalized = normalizedBoundedUsage(result.usage);
  receipt.rawUsage = (result.raw as { usage?: unknown } | undefined)?.usage ?? null;
  receipt.normalizedUsage = normalized;
  receipt.times.completedAt = now;
  receipt.remoteOutcome = result.remoteOutcome ?? null;

  const outputBytes = Buffer.byteLength(result.output, 'utf8');
  const invalidJson = (() => {
    try { JSON.parse(result.output); return false; } catch { return true; }
  })();
  const usageExceeded = (normalized.inputTokens !== null && normalized.inputTokens > bounds.maxInputTokens)
    || (normalized.generatedTokens !== null && normalized.generatedTokens > bounds.maxGeneratedTokens)
    || (normalized.totalTokens !== null && normalized.totalTokens > bounds.maxTotalTokens);
  const incomplete = result.incomplete === true || result.truncated === true
    || outputBytes > bounds.maxOutputBytes || invalidJson || usageExceeded;
  receipt.status = incomplete || !result.ok ? 'incomplete' : 'completed';
  if (!incomplete) return result;

  const reasons = [
    result.error,
    result.truncated ? 'provider reported a length-truncated response; JSON is not admitted as valid' : undefined,
    outputBytes > bounds.maxOutputBytes
      ? `output is ${outputBytes} UTF-8 bytes (limit ${bounds.maxOutputBytes}); retained but not admitted as valid`
      : undefined,
    invalidJson ? 'output is not complete valid JSON' : undefined,
    usageExceeded ? 'provider usage exceeded the reserved hard envelope' : undefined,
  ].filter((value): value is string => Boolean(value));
  return { ...result, ok: false, incomplete: true, error: reasons.join('; ') };
}
