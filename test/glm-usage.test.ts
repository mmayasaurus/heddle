import { describe, expect, it } from 'vitest';
import { parseGlmUsageQuota } from '../src/glm-usage.js';

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
