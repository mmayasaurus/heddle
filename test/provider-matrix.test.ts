import { describe, expect, it } from 'vitest';
import { getProvider, PROVIDER_MATRIX } from '../src/provider-matrix.js';

describe('provider matrix', () => {
  it('preserves the documented blocked and privacy provider sets', () => {
    expect(Object.values(PROVIDER_MATRIX).filter((provider) => provider.blocked).map((provider) => provider.key).sort())
      .toEqual(['meta', 'nvidia']);
    expect(Object.values(PROVIDER_MATRIX).filter((provider) => provider.trainsOnInputs).map((provider) => provider.key).sort())
      .toEqual(['kimi', 'meta', 'mistral']);
  });

  it('preserves native provider, login, and billing classifications', () => {
    expect(Object.values(PROVIDER_MATRIX).filter((provider) => !provider.envRepoint).map((provider) => provider.key).sort())
      .toEqual(['amazonq', 'claude', 'codex', 'copilot', 'cursor', 'gemini']);
    expect(Object.values(PROVIDER_MATRIX).filter((provider) => provider.oneLoginAtATime).map((provider) => provider.key).sort())
      .toEqual(['gemini']);

    const billingClasses = new Set(['subscription-flat', 'subscription-quota', 'free-tier', 'prepaid-credit', 'pay-per-token']);
    for (const provider of Object.values(PROVIDER_MATRIX)) {
      expect(provider.billingClass.length).toBeGreaterThan(0);
      expect(provider.billingClass.every((billingClass) => billingClasses.has(billingClass))).toBe(true);
    }
  });

  it('models native CLI providers without injected credentials', () => {
    expect(PROVIDER_MATRIX.claude).toMatchObject({ envRepoint: false, harnessStyle: 'native-claude', credentialEnvVars: [] });
    expect(PROVIDER_MATRIX.codex).toMatchObject({ envRepoint: false, harnessStyle: 'native-codex', credentialEnvVars: [] });
    expect(PROVIDER_MATRIX.cursor).toMatchObject({ envRepoint: false, harnessStyle: 'native-cursor', credentialEnvVars: [] });
  });

  it('looks up known providers and rejects unknown providers', () => {
    expect(getProvider('glm')).toBeDefined();
    expect(getProvider('glm')).toMatchObject({ envRepoint: true });
    expect(getProvider('nope')).toBeUndefined();
  });

  it('carries the agentic-seat baseUrl matching harnessStyle, never the wrong-compat path', () => {
    // anthropic-compat (claude-harness) seats repoint to the Anthropic-compatible /anthropic base.
    const anthropic = Object.values(PROVIDER_MATRIX).filter((provider) => provider.harnessStyle === 'anthropic-compat');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const provider of anthropic) {
      expect(provider.baseUrl, `${provider.key} baseUrl`).toBeDefined();
      expect(provider.baseUrl!.endsWith('/anthropic'), `${provider.key} baseUrl must be the /anthropic base`).toBe(true);
      // Guard the exact trap docs/PROVIDER-MATRIX.md sets: the OpenAI/coding path is NOT the agentic base.
      expect(provider.baseUrl).not.toContain('/v1');
      expect(provider.baseUrl).not.toContain('/coding/');
    }
    // GLM's verified agentic endpoint is the z.ai /anthropic base, NOT api/coding/paas/v4 (the completions seat, HED-422).
    expect(PROVIDER_MATRIX.glm.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(PROVIDER_MATRIX.kimi.baseUrl).toBe('https://api.moonshot.ai/anthropic');
    expect(PROVIDER_MATRIX.deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic');

    // openai-compat / local-runtime seats, where a baseUrl is known, use an OpenAI-compatible base — never /anthropic.
    const openaiStyle = Object.values(PROVIDER_MATRIX).filter(
      (provider) => provider.harnessStyle === 'openai-compat' || provider.harnessStyle === 'local-runtime',
    );
    for (const provider of openaiStyle) {
      if (provider.baseUrl !== undefined) {
        expect(provider.baseUrl.endsWith('/anthropic'), `${provider.key} baseUrl must not be an /anthropic base`).toBe(false);
      }
    }

    // Native (non-repoint) providers do not carry a repoint baseUrl.
    for (const provider of Object.values(PROVIDER_MATRIX).filter((entry) => !entry.envRepoint)) {
      expect(provider.baseUrl, `${provider.key} is native and must not carry a baseUrl`).toBeUndefined();
    }
  });
});
