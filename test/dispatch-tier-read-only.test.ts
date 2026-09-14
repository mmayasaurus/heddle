import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
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
});
