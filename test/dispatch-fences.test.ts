import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { dispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const savedAccountsPath = process.env.HEDDLE_ACCOUNTS;
afterEach(() => {
  if (savedAccountsPath === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccountsPath;
});

describe('dispatch read-only fences (HED-404)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-fences-test-');
  const { unbound } = IDENTITIES;

  function registry(provider: 'claude' | 'codex' | 'cursor', id: string): void {
    const path = `${tempDir()}/accounts.json`;
    // NB: no explicit `harness` — toAccount() defaults it to the PRODUCTION value (claude-code /
    // codex-cli / cursor-agent), so this exercises the real harness-resolution path (HED-404 r2 caught
    // that keying HARNESS_FENCES by the provider short-name silently made every real account mandate-only).
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, [provider]: [{ id, configDir: null, codexHome: null }] }));
    process.env.HEDDLE_ACCOUNTS = path;
  }

  function caps(provider: string, id: string): CapsByProvider {
    const row = { id, fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false };
    const providerCaps: ProviderCaps = {
      provider, source: 'limits.json', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], accounts: [row], activeAccount: id,
    };
    return { [provider]: providerCaps };
  }

  it('records a confirmed Claude read-only fence and invokes Claude with read-only tools', async () => {
    const id = 'claude-fenced';
    registry('claude', id);
    const fake = fakeAdapter(undefined, { readAgents: false });
    const ledger = tempLedger();

    const outcome = await dispatch({
      taskClass: 'adversarial-review', provider: 'claude', model: 'sonnet', authorProvider: 'cursor',
      prompt: 'review', cwd: tempDir(), identity: unbound,
      accounts: [{ id, configDir: null }], caps: caps('claude', id),
    }, ledger, () => fake.adapter);

    expect(outcome.ok).toBe(true);
    expect(ledger.recent().find((row) => row.id === outcome.ledgerId)?.fence).toBe('fenced');
    const argv = new ClaudeAdapter().buildArgs(fake.calls[0].prompt, fake.calls[0].opts);
    expect(argv).toEqual(expect.arrayContaining(['--tools', 'Read', 'Grep', 'Glob']));
  });

  it('adds the read-only mandate for an unfenced Cursor review and records mandate-only', async () => {
    const id = 'cursor-mandate';
    registry('cursor', id);
    const fake = fakeAdapter();
    const ledger = tempLedger();

    const outcome = await dispatch({
      taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd: tempDir(), identity: unbound,
      caps: caps('cursor', id), rotationAccounts: { codex: [], cursor: [{ id, keyFile: null }] },
    }, ledger, () => fake.adapter);

    expect(outcome.ok).toBe(true);
    expect(ledger.recent().find((row) => row.id === outcome.ledgerId)?.fence).toBe('mandate-only');
    expect(fake.calls[0].prompt).toContain('Never fix, never write.');
  });

  it('leaves fence absent for a non-read-only dispatch', async () => {
    const id = 'codex-edit';
    registry('codex', id);
    const fake = fakeAdapter();
    const ledger = tempLedger();
    const request: DispatchRequest = {
      taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'edit', cwd: tempDir(), identity: unbound,
      caps: caps('codex', id), rotationAccounts: { codex: [{ id, codexHome: null }], cursor: [] },
    };

    const outcome = await dispatch(request, ledger, () => fake.adapter);

    expect(outcome.ok).toBe(true);
    expect(ledger.recent().find((row) => row.id === outcome.ledgerId)?.fence).toBeNull();
  });
});
