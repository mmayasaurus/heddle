import { describe, it, expect } from 'vitest';
import { decideCapabilities } from '../src/capabilities.js';

describe('decideCapabilities', () => {
  it('defaults to no grants for omitted, empty, and blank requests', () => {
    for (const requested of [undefined, [], ['', ' ']]) {
      const decision = decideCapabilities('codex', requested, false);
      expect(decision).toEqual({ granted: [] });
      expect(decision.refusal).toBeUndefined();
    }
  });

  it('grants known codex capabilities in allowlist order without duplicates', () => {
    expect(decideCapabilities('codex', ['net'], false)).toEqual({ granted: ['net'] });
    expect(decideCapabilities('codex', ['browse', 'net', 'net'], false)).toEqual({ granted: ['net', 'browse'] });
  });

  it('requires explicit opt-in before granting exec-privileged', () => {
    const refused = decideCapabilities('codex', ['exec-privileged'], false);
    expect(refused.refusal).toMatchObject({ code: 'capability-denied' });
    expect(refused.refusal?.reason).toContain('opt_in: true');
    expect(refused.refusal?.reason).toContain('exec-privileged');
    expect(decideCapabilities('codex', ['exec-privileged'], true)).toEqual({ granted: ['exec-privileged'] });
  });

  it('refuses an unknown capability before granting any known capability', () => {
    const decision = decideCapabilities('codex', ['net', 'fly'], false);
    expect(decision.granted).toEqual([]);
    expect(decision.refusal?.reason).toContain('"fly"');
    expect(decision.refusal?.reason).toContain('net, browse, exec-privileged');
  });

  it('refuses grants that providers other than codex cannot enforce', () => {
    const cursor = decideCapabilities('cursor', ['net'], false);
    expect(cursor.refusal?.reason).toContain('provider "cursor" cannot enforce');
    expect(cursor.refusal?.reason).toContain('codex enforces it');
    expect(decideCapabilities('gemini', ['browse'], true).refusal?.code).toBe('capability-denied');
    expect(decideCapabilities('unknown-provider', ['net'], false).refusal?.code).toBe('capability-denied');
  });

  it('checks unknown tokens before opt-in and opt-in before provider enforceability', () => {
    expect(decideCapabilities('cursor', ['exec-privileged'], false).refusal?.reason).toContain('opt_in: true');
    expect(decideCapabilities('cursor', ['bogus', 'exec-privileged'], false).refusal?.reason).toContain('unknown capability');
  });
});
