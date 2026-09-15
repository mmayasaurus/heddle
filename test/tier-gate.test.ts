import { describe, expect, it } from 'vitest';
import { tierReadOnlyVerdict } from '../src/dispatcher/tier-gate.js';
import { effectiveFences, harnessFences, NO_FENCE } from '../src/fences.js';
import type { Account, AccountRegistry, AccountTier } from '../src/accounts.js';

function reg(accounts: Array<{
  id: string;
  provider: 'claude' | 'codex' | 'cursor';
  tier?: AccountTier;
  envRepoint?: Account['envRepoint'];
}>): AccountRegistry {
  return {
    schemaVersion: 2,
    accounts: accounts.map((a): Account => ({
      id: a.id, provider: a.provider, harness: a.provider, credentialRef: 'ref',
      ...(a.tier ? { tier: a.tier } : {}),
      ...(a.envRepoint ? { envRepoint: a.envRepoint } : {}),
    })),
  };
}
const load = (accounts: Parameters<typeof reg>[0]) => () => reg(accounts);

describe('tierReadOnlyVerdict (HED-404 structural read-only tier gate)', () => {
  it('REFUSES a T0 account on a non-read-only class (the only positive-evidence path)', () => {
    const v = tierReadOnlyVerdict({ accountId: 't0', provider: 'codex', readOnly: false, loadRegistry: load([{ id: 't0', provider: 'codex', tier: 'T0' }]) });
    expect(v.refusal?.code).toBe('tier-read-only');
    expect(v.refusal?.reason).toContain('T0');
    expect(v.refusal?.instruction).toBeTruthy();
  });

  it('ALLOWS a T0 account on a read-only class (short-circuits before any registry read)', () => {
    const v = tierReadOnlyVerdict({ accountId: 't0', provider: 'codex', readOnly: true, loadRegistry: () => { throw new Error('must not read the registry for a read-only class'); } });
    expect(v.refusal).toBeUndefined();
  });

  it('ALLOWS an untiered account on a non-read-only class (the zero-change-today guarantee)', () => {
    const v = tierReadOnlyVerdict({ accountId: 'plain', provider: 'codex', readOnly: false, loadRegistry: load([{ id: 'plain', provider: 'codex' }]) });
    expect(v.refusal).toBeUndefined();
  });

  it.each(['T1', 'T2', 'T3'] as const)('ALLOWS a higher-tier %s account on a non-read-only class', (tier) => {
    const v = tierReadOnlyVerdict({ accountId: 'hi', provider: 'codex', readOnly: false, loadRegistry: load([{ id: 'hi', provider: 'codex', tier }]) });
    expect(v.refusal).toBeUndefined();
  });

  it('ALLOWS (fails open) when there is no bound account', () => {
    expect(tierReadOnlyVerdict({ accountId: null, provider: 'codex', readOnly: false }).refusal).toBeUndefined();
  });

  it('ALLOWS (fails open) when the account id is not in the registry', () => {
    const v = tierReadOnlyVerdict({ accountId: 'ghost', provider: 'codex', readOnly: false, loadRegistry: load([{ id: 't0', provider: 'codex', tier: 'T0' }]) });
    expect(v.refusal).toBeUndefined();
  });

  it('ALLOWS (fails open) when the registry throws (corrupt/unreadable) — never crashes all dispatch', () => {
    const v = tierReadOnlyVerdict({ accountId: 't0', provider: 'codex', readOnly: false, loadRegistry: () => { throw new Error('corrupt accounts.json'); } });
    expect(v.refusal).toBeUndefined();
  });

  it('resolves on provider AND id (a T0 id under a different provider is not the resolved account)', () => {
    // The T0 belongs to codex; a claude-target dispatch does not resolve it (mirrors billingVerdict's match).
    const v = tierReadOnlyVerdict({ accountId: 't0', provider: 'claude', readOnly: false, loadRegistry: load([{ id: 't0', provider: 'codex', tier: 'T0' }]) });
    expect(v.refusal).toBeUndefined();
  });

  describe('env-repoint accounts', () => {
    const envRepoint = {
      service: 'glm',
      baseUrl: 'https://example.test/v1',
      authTokenRef: 'GLM_KEY',
    };

    it('REFUSES a T0 env-repoint account on a non-read-only service route', () => {
      const v = tierReadOnlyVerdict({
        accountId: 'glm-1', provider: 'glm', readOnly: false,
        loadRegistry: load([{ id: 'glm-1', provider: 'codex', tier: 'T0', envRepoint }]),
      });
      expect(v.refusal?.code).toBe('tier-read-only');
    });

    it('ALLOWS the same T0 env-repoint account on a read-only service route', () => {
      const v = tierReadOnlyVerdict({
        accountId: 'glm-1', provider: 'glm', readOnly: true,
        loadRegistry: load([{ id: 'glm-1', provider: 'codex', tier: 'T0', envRepoint }]),
      });
      expect(v.refusal).toBeUndefined();
    });

    it('ALLOWS a non-T0 env-repoint account on a non-read-only service route', () => {
      const v = tierReadOnlyVerdict({
        accountId: 'glm-1', provider: 'glm', readOnly: false,
        loadRegistry: load([{ id: 'glm-1', provider: 'codex', tier: 'T1', envRepoint }]),
      });
      expect(v.refusal).toBeUndefined();
    });
  });
});

describe('effectiveFences (HED-404 per-harness fence registry, narrow-only)', () => {
  it('claude enforces read-only only (verified: --tools Read Grep Glob is the only boundary)', () => {
    expect(effectiveFences('claude')).toEqual({ readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: false });
  });

  it('codex enforces read-only + cwd + network (verified: --sandbox read-only / workspace-write)', () => {
    expect(effectiveFences('codex')).toEqual({ readOnlyEnforceable: true, networkEnforceable: true, cwdEnforceable: true });
  });

  it('resolves the PRODUCTION harness names (claude-code / codex-cli / cursor-agent), not only the short provider names', () => {
    // accounts.ts toAccount() defaults Account.harness to these long forms; keying only by the short
    // provider name silently made every real account mandate-only (HED-404 r2).
    expect(effectiveFences('claude-code')).toEqual({ readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: false });
    expect(effectiveFences('codex-cli')).toEqual({ readOnlyEnforceable: true, networkEnforceable: true, cwdEnforceable: true });
    expect(effectiveFences('cursor-agent')).toEqual(NO_FENCE);
  });

  it.each(['cursor', 'agy'])('%s enforces nothing (no boundary heddle can rely on)', (h) => {
    expect(effectiveFences(h)).toEqual(NO_FENCE);
  });

  it('an unknown/API harness enforces nothing (safe default — never over-promises)', () => {
    expect(effectiveFences('some-future-cli')).toEqual(NO_FENCE);
    expect(harnessFences('local')).toEqual(NO_FENCE);
  });

  it('a per-account fences declaration may only NARROW the harness, never widen it (acceptance #4)', () => {
    // cursor enforces nothing; an account claiming every fence still gets nothing.
    expect(effectiveFences('cursor', { readOnlyEnforceable: true, networkEnforceable: true, cwdEnforceable: true })).toEqual(NO_FENCE);
    // an account may voluntarily give up codex's real read-only fence.
    expect(effectiveFences('codex', { readOnlyEnforceable: false, networkEnforceable: true, cwdEnforceable: true }))
      .toEqual({ readOnlyEnforceable: false, networkEnforceable: true, cwdEnforceable: true });
  });
});
