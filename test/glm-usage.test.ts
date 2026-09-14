import { describe, expect, it } from 'vitest';
import { fetchGlmUsageQuota, parseGlmUsageQuota } from '../src/glm-usage.js';
import { readProviderCaps } from '../src/usage.js';

describe('parseGlmUsageQuota', () => {
  it('maps Z.ai coding-plan quota pools without fetching or wiring limits', () => {
    const quota = parseGlmUsageQuota({
      code: 200,
      success: true,
      data: {
        level: 'coding-pro',
        limits: [{
          type: 'five_hour', unit: 'tokens', number: 1000, usage: 250,
          currentValue: 250, remaining: 750, percentage: 25, nextResetTime: 1_788_000_000_000,
        }],
      },
    });

    expect(quota).toEqual({
      level: 'coding-pro',
      pools: [{ type: 'five_hour', usage: 250, remaining: 750, percentage: 25, resetAtMs: 1_788_000_000_000 }],
    });
  });
});

describe('GLM quota producer', () => {
  it('maps an exhausted Z.ai five-hour quota into a cap-aware GLM provider snapshot', async () => {
    const quota = await fetchGlmUsageQuota({
      env: { ZAI_API_KEY: 'test-key' },
      fetchImpl: async () => new Response(JSON.stringify({ data: { level: 'coding-pro', limits: [
        { type: 'five_hour', usage: 1000, remaining: 0, percentage: 100, nextResetTime: 1_788_000_000_000 },
        { type: 'weekly', usage: 3000, remaining: 0, percentage: 100, nextResetTime: 1_788_500_000_000 },
      ] } }), { status: 200 }),
    });
    const caps = readProviderCaps({ nowS: 1_787_000_000, glmQuota: quota ?? undefined }).glm;
    expect(caps).toMatchObject({ source: 'glm-quota', stale: false, fiveHour: { usedPercentage: 100 }, sevenDay: { usedPercentage: 100 } });
  });

  it('fails open when Z.ai quota fetch is unauthorized or unavailable', async () => {
    expect(await fetchGlmUsageQuota({ env: { ZAI_API_KEY: 'test-key' }, fetchImpl: async () => new Response('', { status: 401 }) })).toBeNull();
    expect(await fetchGlmUsageQuota({ env: { ZAI_API_KEY: 'test-key' }, fetchImpl: async () => { throw new Error('offline'); } })).toBeNull();
  });

  it('discards malformed quota percentages (out-of-range) so bad data never drives a route-away decision', async () => {
    const quota = await fetchGlmUsageQuota({
      env: { ZAI_API_KEY: 'test-key' },
      fetchImpl: async () => new Response(JSON.stringify({ data: { level: 'coding-pro', limits: [
        { type: 'five_hour', usage: 0, remaining: 0, percentage: 150, nextResetTime: 1_788_000_000_000 },
        { type: 'weekly', usage: 0, remaining: 0, percentage: -5, nextResetTime: 1_788_500_000_000 },
      ] } }), { status: 200 }),
    });
    const caps = readProviderCaps({ nowS: 1_787_000_000, glmQuota: quota ?? undefined }).glm;
    // an over-100 or negative percentage is treated as unknown (usedPercentage null), not usable cap data
    expect(caps.fiveHour.usedPercentage).toBeNull();
    expect(caps.sevenDay.usedPercentage).toBeNull();
  });

  it('authorizes the quota fetch with the provided env key (a request-pinned ZAI_API_KEY)', async () => {
    let seenAuth: string | undefined;
    await fetchGlmUsageQuota({
      env: { ZAI_API_KEY: 'req-specific-key' },
      fetchImpl: async (_input, init) => {
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({ data: { level: 'x', limits: [] } }), { status: 200 });
      },
    });
    expect(seenAuth).toBe('Bearer req-specific-key');
  });
});
