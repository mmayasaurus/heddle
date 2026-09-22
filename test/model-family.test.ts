import { describe, expect, it } from 'vitest';
import { effectiveModelIdentity, sameModelFamily } from '../src/model-family.js';

// HED-697: a claude-harness route bound to an env-repoint account runs the SERVICE's model, so its
// family is the service's. Everything else keeps the route's own identity.
describe('effectiveModelIdentity (HED-697)', () => {
  it('a claude route on an env-repoint account runs as the service family and its pinned model', () => {
    expect(effectiveModelIdentity('claude', 'sonnet', { service: 'glm', model: 'glm-5.3' })).toEqual({ provider: 'glm', model: 'glm-5.3' });
    // No per-account model: the routed model id is what the harness sends.
    expect(effectiveModelIdentity('claude', 'sonnet', { service: 'kimi' })).toEqual({ provider: 'kimi', model: 'sonnet' });
  });

  it('leaves native claude routes and non-claude harnesses unchanged', () => {
    expect(effectiveModelIdentity('claude', 'opus')).toEqual({ provider: 'claude', model: 'opus' });
    expect(effectiveModelIdentity('codex', 'gpt-5.6-terra', { service: 'openrouter' })).toEqual({ provider: 'codex', model: 'gpt-5.6-terra' });
  });

  it('makes a GLM-on-claude reviewer a different family from a Claude author, and the same family as a GLM author', () => {
    const glm = effectiveModelIdentity('claude', 'sonnet', { service: 'glm', model: 'glm-5.3' });
    expect(sameModelFamily(glm.provider, glm.model, 'claude', null)).toBe(false);
    expect(sameModelFamily(glm.provider, glm.model, 'glm', 'glm-5.3')).toBe(true);
  });
});
