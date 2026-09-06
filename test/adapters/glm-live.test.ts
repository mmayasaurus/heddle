import { describe, expect, it } from 'vitest';
import { OpenAICompatAdapter, readSecretsEnvValue } from '../../src/adapters/openai-compat.js';

const live = process.env.HEDDLE_LIVE_TESTS === '1' && Boolean(readSecretsEnvValue('ZAI_API_KEY'));

describe('GLM live adapter round-trip (opt-in)', () => {
  it.skipIf(!live)('returns non-empty content from glm-5.3-flash when HEDDLE_LIVE_TESTS=1 and ZAI_API_KEY is available', async () => {
    const result = await new OpenAICompatAdapter('glm').dispatch('Reply with exactly: glm ok', {
      model: 'glm-5.3-flash', cwd: process.cwd(), timeoutMs: 60_000,
    });
    expect(result.ok).toBe(true);
    expect(result.output.trim()).not.toBe('');
  }, 65_000);
});
