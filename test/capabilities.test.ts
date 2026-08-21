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

  it('refuses exec-privileged unless the OPERATOR enabled it in policy AND the call opted in (two keys)', () => {
    const operatorOff = decideCapabilities('codex', ['exec-privileged'], true);
    expect(operatorOff.refusal).toMatchObject({ code: 'capability-denied' });
    expect(operatorOff.refusal?.reason).toContain('policy.capabilities.allow_exec_privileged');
    expect(operatorOff.refusal?.reason).toContain('A tool argument cannot enable it');
    const on = { allowExecPrivileged: true };
    const noOptIn = decideCapabilities('codex', ['exec-privileged'], false, on);
    expect(noOptIn.refusal).toMatchObject({ code: 'capability-denied' });
    expect(noOptIn.refusal?.reason).toContain('opt_in: true');
    expect(noOptIn.refusal?.reason).toContain('exec-privileged');
    expect(decideCapabilities('codex', ['exec-privileged'], true, on)).toEqual({ granted: ['exec-privileged'] });
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

  it.each(['groq', 'cerebras', 'openrouter'])('refuses every requested capability for %s as unenforceable', (provider) => {
    for (const capability of ['net', 'browse', 'exec-privileged']) {
      const decision = decideCapabilities(provider, [capability], true, { allowExecPrivileged: true });
      expect(decision.refusal).toMatchObject({ code: 'capability-denied', kind: 'unenforceable' });
    }
  });

  it('checks unknown tokens before opt-in and opt-in before provider enforceability', () => {
    const on = { allowExecPrivileged: true };
    expect(decideCapabilities('cursor', ['exec-privileged'], false, on).refusal?.reason).toContain('opt_in: true');
    expect(decideCapabilities('cursor', ['bogus', 'exec-privileged'], false, on).refusal?.reason).toContain('unknown capability');
    // operator gate is checked before opt-in
    expect(decideCapabilities('cursor', ['exec-privileged'], false).refusal?.reason).toContain('allow_exec_privileged');
  });
});
