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
});
