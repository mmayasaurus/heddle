import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatch, planDispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
import { loadRouting } from '../src/routing.js';
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
});
