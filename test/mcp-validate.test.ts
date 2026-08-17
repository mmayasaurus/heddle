import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkerMcp } from '../src/mcp.js';
import { dispatch } from '../src/dispatch.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

/**
 * HED-32 gap-fill + HED-63 regression, both halves. The rest of the policy-module AC is already
 * covered by the suite; the uncovered behavior was the orphan-row guarantee around MCP
 * materialization:
 *
 *  - BEFORE the ledger row: an unknown/unsupported MCP attachment throws at the HED-19 gate
 *    (validateWorkerMcp, dispatch.ts:306) before startUnderCap opens a row (:310) — so a bad
 *    request leaves NO row at all and NO mutated worktree.
 *  - AFTER the ledger row: a materialize failure (materializeWorkerMcp, :392, inside the dispatch
 *    try) is caught (:427) and the row is FINISHED ok=false in the finally (:429) — never left
 *    in flight. This is the harder half of the original bug ("materialize throw after ledger.start
 *    leaves an orphan row").
 *
 * The two halves throw from different call sites, so the assertions differ deliberately: the
 * before-row case makes dispatch REJECT with no row; the after-row case makes dispatch RETURN a
 * finished failure.
 */
describe('validateWorkerMcp — the pre-ledger gate', () => {
  it('rejects an unknown codex MCP server by name', () => {
    expect(() => validateWorkerMcp('codex', ['does-not-exist'])).toThrow(/unknown codex MCP server "does-not-exist"/);
  });

  it('refuses gemini/agy attachment outright (schema unverified — heddle never writes guessed config)', () => {
    expect(() => validateWorkerMcp('gemini', ['memtrace'])).toThrow(/not implemented yet/);
  });

  it('is a no-op when no servers are requested, whatever the provider', () => {
    expect(() => validateWorkerMcp('gemini', [])).not.toThrow(); // zero-servers early return precedes the gemini throw
    expect(() => validateWorkerMcp('cursor', [])).not.toThrow();
    expect(() => validateWorkerMcp('codex', [])).not.toThrow();
  });
});

describe('dispatch — MCP failure never orphans a ledger row (HED-63)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-mcp-orphan-test-');

  it('BEFORE the row: an unknown MCP server throws at the gate — no row, nothing in flight, no worktree write', async () => {
    const ledger = tempLedger();
    const fake = fakeAdapter();
    const cwd = tempDir();
    const before = ledger.recent(100).length;

    // bulk-mechanical → codex; an unknown codex server is rejected by validateWorkerMcp at
    // dispatch.ts:306, strictly before the ledger row opens at :310. The throw string is unique to
    // codexMcpFlags (mcp.ts:46), so this pins the failure to that gate — not an earlier refusal
    // (IDENTITIES.boundU is a non-worker bound identity; it does not depth-1/refuse before the gate).
    await expect(
      dispatch(
        { taskClass: 'bulk-mechanical', prompt: 'x', cwd, mcp: ['does-not-exist'], identity: IDENTITIES.boundU },
        ledger,
        () => fake.adapter,
      ),
    ).rejects.toThrow(/unknown codex MCP server/);

    expect(ledger.recent(100).length).toBe(before); // no row at all — not even a finished refusal
    expect(ledger.inFlight()).toEqual([]);           // nothing left in flight
    expect(fake.calls).toHaveLength(0);              // the worker was never spawned
    // "no mutated worktree" made observable: the throw is before materialization, so nothing wrote.
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
  });

  it('AFTER the row: a materialize failure finishes the row ok=false — it is not left in flight', async () => {
    const ledger = tempLedger();
    const cwd = tempDir();
    // Pre-seed a malformed .cursor/mcp.json so writeMergedMcpJson throws (mcp.ts:206-208) — this
    // passes validateWorkerMcp (cursor + memtrace is a valid attachment) and fails INSIDE the
    // dispatch try, after startUnderCap has opened the row.
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), 'not-json{{ broken', 'utf8');

    // Force the cursor route explicitly: cursor's materializeWorkerMcp actually writes
    // .cursor/mcp.json (codex's is a no-op), and a task-class route can cap-fall-back to codex in a
    // test env with no live caps. A direct provider+model dispatch needs an override reason (HED-95).
    const outcome = await dispatch(
      { provider: 'cursor', model: 'composer-2.5', overrideReason: 'regression: exercise the post-startUnderCap materialize-failure path', prompt: 'x', cwd, mcp: ['memtrace'], identity: IDENTITIES.boundU },
      ledger,
      () => fakeAdapter().adapter,
    );

    // dispatch RETURNS (does not reject) — the throw was caught and the row closed.
    expect(outcome.ok).toBe(false);
    expect(String(outcome.error)).toMatch(/not valid JSON/);
    expect(ledger.inFlight()).toEqual([]);           // the point: no orphan in-flight row
    const row = ledger.recent(1)[0];
    expect(row.finished_at).not.toBeNull();
    expect(row.ok).toBe(0);
  });
});
