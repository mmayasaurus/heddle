import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatch, planDispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
import { loadRouting } from '../src/routing.js';
import { accountCapState, accountAtOrOverCap } from '../src/capaware.js';
import type { Account } from '../src/accounts.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const savedAccountsPath = process.env.HEDDLE_ACCOUNTS;
afterEach(() => {
  if (savedAccountsPath === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccountsPath;
});

describe('dispatch billing enforcement (HED-395)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-billing-test-');
  const { unbound } = IDENTITIES;

  function registry(account: Pick<Account, 'id' | 'billingClass' | 'overage'>): string {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, codex: [{ ...account, codexHome: null }] }));
    process.env.HEDDLE_ACCOUNTS = path;
    return path;
  }

  function providerCaps(accountId: string, usedPercentage: number): CapsByProvider {
    const row = { id: accountId, fiveHour: { usedPercentage, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: usedPercentage >= 100, stale: false };
    const codex: ProviderCaps = { provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], accounts: [row], activeAccount: accountId };
    return { codex };
  }

  function request(accountId: string, usedPercentage = 10): DispatchRequest {
    return {
      taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir(), identity: unbound,
      caps: providerCaps(accountId, usedPercentage),
      rotationAccounts: { codex: [{ id: accountId, codexHome: null }], cursor: [] },
    };
  }

  // A full multi-provider accounts.json (loadAccountRegistry reads it via HEDDLE_ACCOUNTS).
  function writeRegistry(obj: Record<string, unknown>): void {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, ...obj }));
    process.env.HEDDLE_ACCOUNTS = path;
  }

  // codex ProviderCaps whose top-level window is low (never triggers route-away) but whose per-account
  // rows are supplied explicitly — for asserting the billing gate's cap-state branch without the
  // cap-aware router moving the target first.
  function codexCaps(rows: Array<{ id: string; used: number | null; stale?: boolean }>, active?: string): CapsByProvider {
    return { codex: {
      provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: active ?? rows[0]?.id ?? null,
      accounts: rows.map(({ id, used, stale = false }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: used !== null && used >= 100, stale })),
    } };
  }

  it('dispatches a subscription account unchanged', async () => {
    registry({ id: 'included', billingClass: 'subscription-quota' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('included'), tempLedger(), () => fake.adapter);
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses pay-per-token by default with account, class, and exact override lever', async () => {
    registry({ id: 'metered', billingClass: 'pay-per-token' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('metered'), tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0);
    expect(outcome.refusal?.code).toBe('billing.pay-per-token');
    expect(outcome.error).toContain('metered');
    expect(outcome.error).toContain('pay-per-token');
    expect(outcome.error).toContain('policy.cap_aware_routing.permit_pay_per_token: true');
  });

  it('allows pay-per-token only when the permit switch is on', () => {
    registry({ id: 'metered', billingClass: 'pay-per-token' });
    const table = loadRouting();
    (table.policy as any).cap_aware_routing.permit_pay_per_token = true;
    expect(planDispatch(request('metered'), table).billingRefusal).toBeUndefined();
  });

  it('allows open-billing under cap and refuses it at cap', () => {
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    expect(planDispatch(request('open', 99)).billingRefusal).toBeUndefined();
    const plan = planDispatch(request('open', 100));
    expect(plan.billingRefusal).toMatchObject({ code: 'billing.open-billing-at-cap' });
    expect(plan.billingRefusal?.reason).toContain('open');
    expect(plan.billingRefusal?.reason).toContain('subscription-quota');
    expect(plan.billingRefusal?.reason).toContain('open-billing');
    expect(plan.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token');
  });

  it('allows a bounded-prepaid buffer at cap with advice, then refuses zero credits', () => {
    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 7, spendLimit: 20 } });
    const allowed = planDispatch(request('buffer', 100));
    expect(allowed.billingRefusal).toBeUndefined();
    expect(allowed.billingAdvice).toBe('burning prepaid buffer (7 of 20)');

    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 0, spendLimit: 20 } });
    const refused = planDispatch(request('buffer', 10));
    expect(refused.billingRefusal).toMatchObject({ code: 'billing.prepaid-exhausted' });
    expect(refused.billingRefusal?.reason).toContain('credits exhausted');
    expect(refused.billingRefusal?.reason).toContain('buffer');
    expect(refused.billingRefusal?.reason).toContain('prepaid-credit');
    expect(refused.billingRefusal?.reason).toContain('bounded-prepaid');
    expect(refused.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token');
  });

  it('treats missing, stale, and null account caps as unknown without throwing', () => {
    const malformed = { provider: 'codex', fiveHour: { usedPercentage: 10 } } as unknown as ProviderCaps;
    expect(accountCapState(undefined, 'a')).toBe('unknown');
    expect(accountCapState(malformed, 'a')).toBe('unknown');
    expect(accountAtOrOverCap(malformed, 'a')).toBe(false);
    expect(accountCapState(codexCaps([{ id: 'a', used: null }]).codex, 'a')).toBe('unknown');
    expect(accountCapState(codexCaps([{ id: 'a', used: 100, stale: true }]).codex, 'a')).toBe('unknown');
  });

  it('refuses open-billing when the bound account cap state is unknown', async () => {
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    const req = request('open');
    req.caps = codexCaps([]);
    const preview = planDispatch(req);
    expect(preview.billingRefusal?.reason).toContain("open-billing account 'open' (billingClass subscription-quota): cap state unknown");
    expect(preview.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token: true');

    const fake = fakeAdapter();
    const outcome = await dispatch(req, tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0);
    expect(outcome.refusal).toEqual(preview.billingRefusal);
  });

  it('loud-degrades an unregistered bound account onto the outcome and ledger row', async () => {
    writeRegistry({ codex: [] });
    const fake = fakeAdapter(); const ledger = tempLedger();
    const outcome = await dispatch(request('manual'), ledger, () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.billingDegraded).toEqual({ reason: 'billing-degraded:account-unregistered(manual)' });
    expect(ledger.get(outcome.ledgerId)?.error).toContain('billing-degraded:account-unregistered(manual)');
  });

  it('loud-degrades an unreadable registry instead of crashing dispatch', async () => {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, '{broken');
    process.env.HEDDLE_ACCOUNTS = path;
    const fake = fakeAdapter(); const ledger = tempLedger();
    const outcome = await dispatch(request('included'), ledger, () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.billingDegraded).toEqual({ reason: 'billing-degraded:registry-unreadable' });
    expect(ledger.get(outcome.ledgerId)?.error).toContain('billing-degraded:registry-unreadable');
  });

  it('allows bounded prepaid with unknown caps loudly, and cleanly allows no overage object', async () => {
    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 7, spendLimit: 20 } });
    const staleReq = request('buffer'); staleReq.caps = codexCaps([{ id: 'buffer', used: 100, stale: true }]);
    const fake = fakeAdapter(); const ledger = tempLedger();
    const stale = await dispatch(staleReq, ledger, () => fake.adapter);
    expect(stale.billingDegraded).toEqual({ reason: 'billing-degraded:prepaid-caps-stale' });
    expect(ledger.get(stale.ledgerId)?.error).toContain('billing-degraded:prepaid-caps-stale');

    registry({ id: 'plain', billingClass: 'prepaid-credit' });
    const clean = await dispatch(request('plain'), tempLedger(), () => fake.adapter);
    expect(clean.ok).toBe(true);
    expect(clean.billingDegraded).toBeUndefined();
  });

  it('refuses a pay-per-token account rebound by account failover before spawning it', async () => {
    writeRegistry({ codex: [
      { id: 'included', codexHome: '/included', billingClass: 'subscription-quota' },
      { id: 'metered', codexHome: '/metered', billingClass: 'pay-per-token' },
    ] });
    const cwd = tempDir(); const coolingPath = `${tempDir()}/cooling.json`;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      await fake.adapter.dispatch(prompt, opts);
      return { ok: false, output: '', error: '429 rate limit', exitCode: 1 };
    } };
    const outcome = await dispatch({
      taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound,
      caps: codexCaps([{ id: 'included', used: 10 }, { id: 'metered', used: 10 }], 'included'),
      rotationAccounts: { codex: [{ id: 'included', codexHome: '/included' }, { id: 'metered', codexHome: '/metered' }], cursor: [] },
      coolingPath, nowS: 100,
    }, tempLedger(), () => adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome).toMatchObject({ account: 'metered', usedFallback: true, refusal: { code: 'billing.pay-per-token' } });
    expect(outcome.error).toContain('policy.cap_aware_routing.permit_pay_per_token: true');
  });

  it("preserves today's three unclassified subscription accounts across all dispatch paths", async () => {
    writeRegistry({
      claude: [{ id: 'claude-current', configDir: null }],
      codex: [{ id: 'default', codexHome: '/codex-current' }],
      cursor: [{ id: 'cursor-current', keyFile: null }],
    });
    const rotationAccounts = {
      codex: [{ id: 'default', codexHome: '/codex-current' }],
      cursor: [{ id: 'cursor-current', keyFile: null }],
    };
    const caps = codexCaps([{ id: 'default', used: 10 }]);

    const primaryFake = fakeAdapter(undefined, { readAgents: false });
    const primary = await dispatch({ ...request('default'), rotationAccounts }, tempLedger(), () => primaryFake.adapter);
    expect(primary).toMatchObject({ ok: true, account: 'default', provider: 'codex' });
    expect(primary.billingDegraded).toBeUndefined();

    const failoverFake = fakeAdapter(undefined, { readAgents: false }); let attempts = 0;
    const failoverAdapter = { ...failoverFake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof failoverFake.adapter.dispatch>[1]) => {
      attempts += 1; await failoverFake.adapter.dispatch(prompt, opts);
      return attempts === 1 ? { ok: false, output: '', error: '429 rate limit', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const failover = await dispatch({ ...request('default'), rotationAccounts }, tempLedger(), () => failoverAdapter);
    // Today's one-Codex-account registry has no distinct account to rebound to; preserve that
    // pre-gate outcome exactly (one failed attempt, no billing refusal/degradation). The dedicated
    // two-account test above is the red-if-runTarget-gate-deleted rebound enforcement proof.
    expect(failover).toMatchObject({ ok: false, account: 'default', provider: 'codex', usedFallback: false });
    expect(failover.billingDegraded).toBeUndefined();

    const capabilityFake = fakeAdapter(undefined, { readAgents: false });
    const claudeCaps: ProviderCaps = {
      provider: 'claude', source: 'claude-tap', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'claude-current',
      accounts: [{ id: 'claude-current', fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    };
    const capability = await dispatch({
      taskClass: 'research-summarize', capabilities: ['net'], prompt: 'x', cwd: tempDir(), identity: unbound,
      accounts: [{ id: 'claude-current', configDir: null, loggedIn: true }], caps: { ...caps, claude: claudeCaps }, rotationAccounts,
    }, tempLedger(), () => capabilityFake.adapter);
    expect(capability).toMatchObject({ ok: true, account: 'default', provider: 'codex', usedFallback: true });
    expect(capability.billingDegraded).toBeUndefined();

    const fallbackFake = fakeAdapter(undefined, { readAgents: false }); let fallbackCalls = 0;
    const fallbackAdapter = { ...fallbackFake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fallbackFake.adapter.dispatch>[1]) => {
      fallbackCalls += 1; await fallbackFake.adapter.dispatch(prompt, opts);
      return fallbackCalls === 1 ? { ok: false, output: '', error: 'socket closed', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const fallback = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, caps, rotationAccounts }, tempLedger(), () => fallbackAdapter);
    expect(fallback).toMatchObject({ ok: true, account: 'cursor-current', provider: 'cursor', usedFallback: true });
    expect(fallback.billingDegraded).toBeUndefined();

    const resumeFake = fakeAdapter(undefined, { readAgents: false });
    const resumed = await dispatch({ ...request('default'), resume: 'default', rotationAccounts }, tempLedger(), () => resumeFake.adapter);
    expect(resumed).toMatchObject({ ok: true, account: 'default' });
    expect(resumed.billingDegraded).toBeUndefined();

    const preview = planDispatch({ ...request('default'), rotationAccounts });
    expect(preview.billingRefusal).toBeUndefined();
    expect(preview.billingAdvice).toBeUndefined();
  });
});
