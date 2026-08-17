import { describe, it, expect } from 'vitest';
import { validateWorkerMcp } from '../src/mcp.js';
import { dispatch } from '../src/dispatch.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

/**
 * HED-32 gap-fill + HED-63 regression. The rest of the policy-module AC is already covered by the
 * suite; the one behavior with no test was the fail-fast contract (dispatch.ts:302-306): an
 * unknown/unsupported MCP attachment must throw BEFORE a ledger row is opened, so a bad request
 * never leaves an orphan in-flight row or a mutated worktree.
 */
describe('validateWorkerMcp — the pre-ledger gate', () => {
  it('rejects an unknown codex MCP server by name', () => {
    expect(() => validateWorkerMcp('codex', ['does-not-exist'])).toThrow(/unknown codex MCP server "does-not-exist"/);
  });

  it('refuses gemini/agy attachment outright (schema unverified — heddle never writes guessed config)', () => {
    expect(() => validateWorkerMcp('gemini', ['memtrace'])).toThrow(/not implemented yet/);
  });

  it('is a no-op when no servers are requested, whatever the provider', () => {
    expect(() => validateWorkerMcp('gemini', [])).not.toThrow(); // the unimplemented provider is fine with zero servers
    expect(() => validateWorkerMcp('cursor', [])).not.toThrow();
    expect(() => validateWorkerMcp('codex', [])).not.toThrow();
  });
});

describe('dispatch — a rejected MCP attachment leaves NO orphan ledger row (HED-63)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-mcp-orphan-test-');

  it('throws before startUnderCap, so nothing is written and nothing is in flight', async () => {
    const ledger = tempLedger();
    const cwd = tempDir();
    const before = ledger.recent(100).length;

    // bulk-mechanical routes to codex; an unknown codex server is rejected by validateWorkerMcp at
    // dispatch.ts:306 — strictly before the ledger row opens at :310.
    await expect(
      dispatch(
        { taskClass: 'bulk-mechanical', prompt: 'x', cwd, mcp: ['does-not-exist'], identity: IDENTITIES.boundU },
        ledger,
        () => fakeAdapter().adapter,
      ),
    ).rejects.toThrow(/unknown codex MCP server/);

    // The point of the fix: no row at all (not even a finished refusal), and nothing left in flight.
    expect(ledger.recent(100).length).toBe(before);
    expect(ledger.inFlight()).toEqual([]);
  });

  it('the adapter is never invoked when validation fails', async () => {
    const ledger = tempLedger();
    const fake = fakeAdapter();
    await expect(
      dispatch(
        { taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), mcp: ['does-not-exist'], identity: IDENTITIES.boundU },
        ledger,
        () => fake.adapter,
      ),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0); // no worker was ever spawned for a request we refused up front
  });
});
