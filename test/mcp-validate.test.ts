import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkerMcp, workerMcpSupported } from '../src/mcp.js';
import { dispatch } from '../src/dispatch.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

/**
 * HED-32 residual coverage. Most of the policy-module AC is already tested — and, per a review of
 * the first cut of this file, the BEFORE-ledger fail-fast path (unknown MCP server / not-implemented
 * gemini → no orphan row, no mutated worktree) is already covered end-to-end by
 * `test/dispatch-caps.test.ts:127-135`. This file therefore adds only what is genuinely uncovered:
 *
 *  1. a DIRECT unit contract for `validateWorkerMcp` (the exported gate itself, incl. the
 *     zero-servers no-op that the dispatch-level tests don't exercise);
 *  2. the AFTER-ledger half of the HED-63 regression: a *materialize* failure that throws INSIDE
 *     the dispatch try (materializeWorkerMcp, dispatch.ts:392) must FINISH the row, not orphan it.
 *     `dispatch-caps.test.ts:137` proves that for an *adapter* throw; this pins the same guarantee
 *     for the distinct materialize throw-site, so moving materialization out of the try would fail
 *     here even though the adapter-throw test would still pass.
 */
describe('validateWorkerMcp — direct unit contract', () => {
  it('rejects an unknown codex MCP server by name', () => {
    expect(() => validateWorkerMcp('codex', ['does-not-exist'])).toThrow(/unknown codex MCP server "does-not-exist"/);
  });

  it('refuses gemini/agy attachment outright (schema unverified — heddle never writes guessed config)', () => {
    expect(() => validateWorkerMcp('gemini', ['memtrace'])).toThrow(/not implemented yet/);
  });

  it('keeps workerMcpSupported aligned with the validateWorkerMcp attachment gate (HED-205)', () => {
    for (const provider of ['codex', 'claude', 'cursor', 'gemini', 'openrouter']) {
      let threw = false;
      try { validateWorkerMcp(provider, ['memtrace']); } catch { threw = true; }
      expect(workerMcpSupported(provider)).toBe(!threw);
    }
  });

  it('is a no-op when no servers are requested, whatever the provider (not covered at the dispatch level)', () => {
    expect(() => validateWorkerMcp('gemini', [])).not.toThrow(); // the zero-servers early return precedes the gemini throw
    expect(() => validateWorkerMcp('cursor', [])).not.toThrow();
    expect(() => validateWorkerMcp('codex', [])).not.toThrow();
  });
});

describe('dispatch — a materialize failure AFTER the row opens finishes it, never orphans (HED-63)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-mcp-orphan-test-');

  it('a throw inside materializeWorkerMcp is caught and the row is finished ok=false, not left in flight', async () => {
    const ledger = tempLedger();
    const cwd = tempDir();
    // Seed a malformed .cursor/mcp.json so writeMergedMcpJson throws (mcp.ts:206-208). This passes
    // validateWorkerMcp (cursor + memtrace is valid) and fails INSIDE the dispatch try, AFTER
    // startUnderCap has opened the row. Force the cursor route explicitly — cursor's materialize
    // actually writes .cursor/mcp.json (codex's is a no-op), and a task-class route can cap-fall-back
    // to codex in a test env; a direct provider+model route needs an override reason (HED-95).
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), 'not-json{{ broken', 'utf8');

    const outcome = await dispatch(
      { provider: 'cursor', model: 'composer-2.5', overrideReason: 'regression: exercise the post-startUnderCap materialize-failure path', prompt: 'x', cwd, mcp: ['memtrace'], identity: IDENTITIES.boundU },
      ledger,
      () => fakeAdapter().adapter,
    );

    // dispatch RETURNS (does not reject) — the throw was caught (dispatch.ts:427) and the row closed
    // in the finally (:429). The point of HED-63: no orphan in-flight row.
    expect(outcome.ok).toBe(false);
    expect(String(outcome.error)).toMatch(/not valid JSON/);
    expect(ledger.inFlight()).toEqual([]);
    const row = ledger.recent(1)[0];
    expect(row.finished_at).not.toBeNull();
    expect(row.ok).toBe(0);
  });
});
