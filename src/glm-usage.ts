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

/** Pure parser for Z.ai Coding Plan's quota response; Stage 1 deliberately does not fetch or wire limits.json. */
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
