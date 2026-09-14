export interface GlmUsagePool {
  type: string;
  usage: number;
  remaining: number;
  percentage: number;
  resetAtMs: number;
}

export interface GlmUsageQuota {
  level: string;
  pools: GlmUsagePool[];
}

export interface GlmQuotaFetchDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  httpTimeoutMs?: number;
  quotaUrl?: string;
}

export const GLM_QUOTA_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const GLM_QUOTA_TIMEOUT_MS = 5_000;

/** Pure parser for Z.ai Coding Plan's quota response. */
export function parseGlmUsageQuota(input: unknown): GlmUsageQuota | null {
  if (!input || typeof input !== 'object') return null;
  const data = (input as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const { level, limits } = data as { level?: unknown; limits?: unknown };
  if (typeof level !== 'string' || !Array.isArray(limits)) return null;
  const pools: GlmUsagePool[] = [];
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') return null;
    const { type, usage, remaining, percentage, nextResetTime } = limit as Record<string, unknown>;
    if (typeof type !== 'string' || typeof usage !== 'number' || typeof remaining !== 'number' || typeof percentage !== 'number' || typeof nextResetTime !== 'number') return null;
    pools.push({ type, usage, remaining, percentage, resetAtMs: nextResetTime });
  }
  return { level, pools };
}

/** Read the Z.ai Coding Plan quota without letting a missing key or failed HTTP call block dispatch. */
export async function fetchGlmUsageQuota(deps: GlmQuotaFetchDeps = {}): Promise<GlmUsageQuota | null> {
  const key = (deps.env ?? process.env).ZAI_API_KEY;
  if (!key) return null;
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(deps.quotaUrl ?? GLM_QUOTA_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(deps.httpTimeoutMs ?? GLM_QUOTA_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return parseGlmUsageQuota(await response.json());
  } catch {
    return null;
  }
}
