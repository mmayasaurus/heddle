import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// REV-1 for the tier gate (HED-404): the auto-effort classifier (classifyEffort → classify → the codex
// classifier adapter) must NEVER run for a tier-refused primary — the plan-level tier gate fires BEFORE
// classifyEffort, exactly like billing's plan-level gate. Mock the codex adapter module (the same seam
// classify.test.ts / dispatch-billing.test.ts use) so we can assert the classifier was NOT invoked. The
// WORKER dispatch uses the INJECTED fake adapter (dispatch()'s 3rd arg), never `new CodexAdapter()`, so
// this mock is inert for the spawn tests below.
const { classifierDispatch } = vi.hoisted(() => ({
  classifierDispatch: vi.fn(async () => ({ ok: true, output: 'low', exitCode: 0 })),
}));
vi.mock('../src/adapters/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/codex.js')>();
  return { ...actual, CodexAdapter: class { dispatch = classifierDispatch; } };
});

import { dispatch, planDispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
import { summarizePlan } from '../src/dispatcher/plan.js';
import type { AccountTier } from '../src/accounts.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

// HED-404 acceptance at the PIPELINE level (adapter-only proof is insufficient — the gate must be
// WIRED and must actually stop the spawn). Mirrors the dispatch-billing harness: a codex account bound
// via rotationAccounts + caps, dispatched at a NON-read_only class (bulk-mechanical is edits_code), so
// the structural tier gate is the only thing that can veto. The account declares NO billingClass, so the
// billing gate (which runs first) cleanly allows and the tier gate is what's under test.

const savedAccountsPath = process.env.HEDDLE_ACCOUNTS;
afterEach(() => {
  classifierDispatch.mockClear();
  if (savedAccountsPath === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccountsPath;
});

describe('dispatch structural read-only tier gate (HED-404)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-tier-test-');
  const { unbound } = IDENTITIES;

  function registry(account: { id: string; tier?: AccountTier }): void {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, codex: [{ ...account, codexHome: null }] }));
    process.env.HEDDLE_ACCOUNTS = path;
  }

  function providerCaps(accountId: string): CapsByProvider {
    const row = { id: accountId, fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false };
    const codex: ProviderCaps = {
      provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], accounts: [row], activeAccount: accountId,
    };
    return { codex };
  }

  // A non-read_only (edits_code) class dispatch bound to the given codex account.
  function request(accountId: string): DispatchRequest {
    return {
      taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir(), identity: unbound,
      caps: providerCaps(accountId),
      rotationAccounts: { codex: [{ id: accountId, codexHome: null }], cursor: [] },
    };
  }

  it('refuses when only a T0 account is available for a non-read-only class — and does NOT spawn', async () => {
    registry({ id: 't0', tier: 'T0' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('t0'), tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0); // structural refusal consumes no spawn
    expect(outcome.refusal?.code).toBe('tier-read-only');
    expect(outcome.error).toContain('T0');
  });

  it('spawns unchanged when the SAME account declares no tier (the zero-change-today guarantee)', async () => {
    registry({ id: 'plain' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('plain'), tempLedger(), () => fake.adapter);
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('does NOT spend an auto-effort classifier when a T0 account is refused (REV-1 parity with billing)', async () => {
    registry({ id: 't0', tier: 'T0' });
    const fake = fakeAdapter();
    // autoEffort would classify the sub-task BEFORE the spawn; the plan-level tier gate must refuse first,
    // or a request known to be tier-ineligible spends (and ledgers) a classifier dispatch.
    const outcome = await dispatch({ ...request('t0'), autoEffort: true }, tempLedger(), () => fake.adapter);
    expect(outcome.refusal?.code).toBe('tier-read-only');
    expect(fake.calls).toHaveLength(0);                // no worker spawn
    expect(classifierDispatch).not.toHaveBeenCalled(); // and no classifier spent — the pre-gate fired first
  });

  it('surfaces the tier refusal in the dry-run preview so plan and run agree (F7 parity)', () => {
    registry({ id: 't0', tier: 'T0' });
    const summary = summarizePlan(planDispatch(request('t0')));
    expect(summary.would_run).toBeNull();
    expect((summary.refusal as { code?: string } | null)?.code).toBe('tier-read-only');
  });
});
