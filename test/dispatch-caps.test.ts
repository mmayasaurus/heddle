import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
import type { WorkerAdapter } from '../src/types.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

describe('dispatch — structural caps', () => {
  const { tempDir, tempLedger, trackLedger } = useTempResources('heddle-dispatch-caps-test-');
  const { unbound, boundU } = IDENTITIES;
  function record(orchestrator: string | null) {
    return { orchestrator, taskClass: 'bulk-mechanical', provider: 'codex', model: 'm', skills: null, issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null };
  }

  it('refuses a nested worker before evaluating the class in-session refusal', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter(); const cwd = tempDir();
    const identity = { agent: null, source: 'unbound', worker: { dispatchId: 7, parent: 'K' } } as const;
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity }, ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('depth-1');
    expect(outcome.refusal?.reason).toContain('HEDDLE_WORKER=1');
    expect(outcome.refusal?.reason).toContain('dispatch #7');
    expect(outcome.refusal?.reason).toContain('parent K');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'depth-1', ok: 0, task_class: 'bulk-mechanical' });
    expect(ledger.recent(1)[0].finished_at).not.toBeNull(); expect(ledger.inFlight()).toEqual([]);
    expect((await dispatch({ taskClass: 'implementation', prompt: 'x', cwd, identity }, ledger, () => fake.adapter)).refusal?.code).toBe('depth-1');
  });

  it('attributes a refused nested dispatch to the worker\'s parent orchestrator (identity_source worker-parent)', async () => {
    const ledger = tempLedger();
    const identity = { agent: null, source: 'unbound', worker: { dispatchId: 7, parent: 'K' } } as const;
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity }, ledger, () => fakeAdapter().adapter);
    expect(outcome).toMatchObject({ orchestrator: 'K', identitySource: 'worker-parent', refusal: { code: 'depth-1' } });
    expect(ledger.recent(1)[0]).toMatchObject({ orchestrator: 'K', identity_source: 'worker-parent', refusal: 'depth-1' });
    // a worker whose parent is unknown stays unattributed
    const orphan = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: { agent: null, source: 'unbound', worker: { dispatchId: null, parent: null } } }, ledger, () => fakeAdapter().adapter);
    expect(orphan).toMatchObject({ orchestrator: null, identitySource: null, refusal: { code: 'depth-1' } });
  });

  it('attributes ledger rows to bound identity before a caller orchestrator', async () => {
    const fake = fakeAdapter(); const ledger = tempLedger(); const cwd = tempDir();
    const bound = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: boundU, orchestrator: 'K' }, ledger, () => fake.adapter);
    expect(bound).toMatchObject({ orchestrator: 'U', identitySource: 'bound', ignoredCallerAgent: 'K' });
    expect(ledger.recent(1)[0]).toMatchObject({ orchestrator: 'U', identity_source: 'bound' });
    const caller = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound, orchestrator: 'K' }, ledger, () => fake.adapter);
    expect(caller).toMatchObject({ orchestrator: 'K', identitySource: 'caller' }); expect(caller).not.toHaveProperty('ignoredCallerAgent');
    const anonymous = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound }, ledger, () => fake.adapter);
    expect(ledger.recent(1)[0]).toMatchObject({ orchestrator: null, identity_source: null }); expect(anonymous.orchestrator).toBeNull();
  });

  it('stamps every worker environment while preserving caller account selection', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter(); const cwd = tempDir();
    const bound = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: boundU, env: { CODEX_HOME: '/tmp/acct' } }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.env).toEqual(expect.objectContaining({ HEDDLE_WORKER: '1', HEDDLE_PARENT: 'U', CODEX_HOME: '/tmp/acct' }));
    expect(Number(fake.calls[0].opts.env?.HEDDLE_DISPATCH_ID)).toBe(bound.ledgerId);
    const anonymous = fakeAdapter();
    await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound }, ledger, () => anonymous.adapter);
    expect(anonymous.calls[0].opts.env).toMatchObject({ HEDDLE_WORKER: '1' });
    expect(anonymous.calls[0].opts.env).not.toHaveProperty('HEDDLE_PARENT');
  });

  it('passes enforced capabilities through to codex and records terminal capability refusals', async () => {
    const ledgerDir = tempDir(); const dbPath = join(ledgerDir, 'ledger.db');
    const ledger = trackLedger(new Ledger(dbPath)); const cwd = tempDir(); const fake = fakeAdapter();
    const granted = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, capabilities: ['net', 'browse'], identity: unbound }, ledger, () => fake.adapter);
    expect(granted.capabilities).toEqual(['net', 'browse']); expect(fake.calls[0].opts.capabilities).toEqual(['net', 'browse']); expect(ledger.recent(1)[0].capabilities).toBe('net,browse');
    const denied = fakeAdapter();
    const refusal = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, capabilities: ['exec-privileged'], identity: unbound }, ledger, () => denied.adapter);
    expect(refusal.refusal?.code).toBe('capability-denied'); expect(denied.calls).toHaveLength(0); expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'capability-denied', finished_at: expect.any(String) });
    const privileged = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, capabilities: ['exec-privileged'], optIn: true, identity: unbound }, ledger, () => fake.adapter);
    expect(privileged.capabilities).toEqual(['exec-privileged']);
    const cursor = fakeAdapter();
    const cursorRefusal = await dispatch({ taskClass: 'scaffold', prompt: 'x', cwd, capabilities: ['net'], identity: unbound }, ledger, () => cursor.adapter);
    expect(cursorRefusal.refusal?.code).toBe('capability-denied'); expect(cursor.calls).toHaveLength(0);
  });

  it('enforces named concurrency caps independently and ignores stale rows', async () => {
    const ledgerDir = tempDir(); const dbPath = join(ledgerDir, 'ledger.db');
    const ledger = trackLedger(new Ledger(dbPath)); const cwd = tempDir(); const fake = fakeAdapter();
    const ids = Array.from({ length: 8 }, () => ledger.start(record('Z')));
    const blocked = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, orchestrator: 'Z', identity: unbound }, ledger, () => fake.adapter);
    expect(blocked.refusal?.code).toBe('max-children'); expect(blocked.refusal?.reason).toContain('already has 8 worker(s) in flight'); expect(blocked.refusal?.reason).toContain('cap 8'); expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'max-children', ok: 0, finished_at: expect.any(String) }); expect(ledger.inFlightCount('Z', 3 * 60 * 60 * 1000)).toBe(8);
    ledger.finish(ids[0], { ok: true });
    expect((await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, orchestrator: 'Z', identity: unbound }, ledger, () => fake.adapter)).ok).toBe(true);
    expect((await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, orchestrator: 'Y', identity: unbound }, ledger, () => fake.adapter)).ok).toBe(true);
    for (let i = 0; i < 8; i++) ledger.start(record('S'));
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE dispatches SET started_at = '2020-01-01T00:00:00.000Z' WHERE orchestrator = 'S'"); raw.close();
    expect(ledger.inFlightCount('S', 3 * 60 * 60 * 1000)).toBe(0);
    expect((await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, orchestrator: 'S', identity: unbound }, ledger, () => fake.adapter)).ok).toBe(true);
  });

  it('fails HED-19 attachment validation before creating a ledger row or materializing skills', async () => {
    const cwd = tempDir(); const ledger = tempLedger(); const fake = fakeAdapter();
    await expect(dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, skills: ['no-such-pack'], identity: unbound }, ledger, () => fake.adapter)).rejects.toThrow(/skill pack "no-such-pack" not found/);
    expect(fake.calls).toHaveLength(0); expect(ledger.recent(1)).toEqual([]); expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    await expect(dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, mcp: ['no-such-server'], identity: unbound }, ledger, () => fake.adapter)).rejects.toThrow(/unknown codex MCP server/);
    expect(ledger.recent(1)).toEqual([]);
    await expect(dispatch({ taskClass: 'documentation', prompt: 'x', cwd, mcp: ['memtrace'], identity: unbound }, ledger, () => fake.adapter)).rejects.toThrow(/not implemented yet/);
    expect(ledger.recent(1)).toEqual([]);
  });

  it('finishes and restores a materialized dispatch when its adapter throws', async () => {
    const cwd = tempDir(); const ledger = tempLedger();
    const adapter: WorkerAdapter = { name: 'throwing', provider: 'codex', dispatch: async () => { throw new Error('adapter exploded'); } };
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound }, ledger, () => adapter);
    expect(outcome).toMatchObject({ ok: false, error: 'adapter exploded' });
    expect(ledger.recent(1)[0]).toMatchObject({ ok: 0, error: 'adapter exploded', finished_at: expect.any(String) });
    expect(ledger.inFlight()).toEqual([]); expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });

  it('keeps class policy when explicit codex provider and model request a capability', async () => {
    const fake = fakeAdapter();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-sol', capabilities: ['net'], prompt: 'x', cwd: tempDir(), identity: unbound }, tempLedger(), () => fake.adapter);
    expect(outcome).toMatchObject({ ok: true, taskClass: 'bulk-mechanical', capabilities: ['net'] });
  });
});
