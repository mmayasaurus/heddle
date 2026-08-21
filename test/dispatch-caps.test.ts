import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dispatch, planDispatch, summarizePlan } from '../src/dispatch.js';
import { loadRouting } from '../src/routing.js';
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
    // a worker whose parent is unknown is still marked as a nested attempt (unattributed)
    const orphan = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: { agent: null, source: 'unbound', worker: { dispatchId: null, parent: null } } }, ledger, () => fakeAdapter().adapter);
    expect(orphan).toMatchObject({ orchestrator: null, identitySource: 'worker-parent', refusal: { code: 'depth-1' } });
    // and an inherited/planted bound identity inside a worker does not make it look like the parent's own dispatch
    const spoofed = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: { agent: 'K', source: 'env:HEDDLE_AGENT', worker: { dispatchId: 3, parent: null } } }, ledger, () => fakeAdapter().adapter);
    expect(spoofed).toMatchObject({ orchestrator: 'K', identitySource: 'worker-parent', refusal: { code: 'depth-1' } });
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
    expect(refusal.refusal?.code).toBe('capability-denied'); expect(denied.calls).toHaveLength(0);
    // the refusal row records what was ASKED
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'capability-denied', capabilities: 'exec-privileged', finished_at: expect.any(String) });
    // opt_in alone is NOT enough with the shipped policy (operator gate off) …
    const optInOnly = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, capabilities: ['exec-privileged'], optIn: true, identity: unbound }, ledger, () => denied.adapter);
    expect(optInOnly.refusal?.code).toBe('capability-denied'); expect(optInOnly.refusal?.reason).toContain('allow_exec_privileged'); expect(denied.calls).toHaveLength(0);
    // … but with an operator-enabled table (HEDDLE_ROUTING) + opt_in it is granted
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync, readFileSync: rf } = await import('node:fs');
    const shipped = rf(join(process.cwd(), 'routing', 'routing.v0.yaml'), 'utf8');
    writeFileSync(yamlPath, shipped.replace('allow_exec_privileged: false', 'allow_exec_privileged: true'));
    const prev = process.env.HEDDLE_ROUTING;
    try {
      process.env.HEDDLE_ROUTING = yamlPath;
      const privileged = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, capabilities: ['exec-privileged'], optIn: true, identity: unbound }, ledger, () => fake.adapter);
      expect(privileged.capabilities).toEqual(['exec-privileged']);
    } finally {
      if (prev === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = prev;
    }
    // capability-FIT fallback: scaffold's primary (cursor) cannot enforce `net`, its declared codex
    // fallback can — the dispatch routes there instead of dying on the refusal.
    const cursor = fakeAdapter();
    const fit = await dispatch({ taskClass: 'scaffold', prompt: 'x', cwd, capabilities: ['net'], identity: unbound }, ledger, () => cursor.adapter);
    expect(fit.ok).toBe(true);
    expect(fit.refusal).toBeUndefined();
    expect(cursor.calls).toHaveLength(1);
    expect(cursor.calls[0].opts.model).toBe('gpt-5.6-luna');
    expect(cursor.calls[0].opts.capabilities).toEqual(['net']);
    expect(fit.usedFallback).toBe(true);
    expect(ledger.recent(1)[0]).toMatchObject({ model: 'gpt-5.6-luna', capabilities: 'net', fell_back_from: 'cursor/composer-2.5 (capability-unenforceable)' });
    // …but a TERMINAL kind (unknown token) never falls back, even with a fallback declared
    const bogus = fakeAdapter();
    const terminal = await dispatch({ taskClass: 'scaffold', prompt: 'x', cwd, capabilities: ['fly'], identity: unbound }, ledger, () => bogus.adapter);
    expect(terminal.refusal?.code).toBe('capability-denied'); expect(bogus.calls).toHaveLength(0);
  });

  it('unions web-research class capabilities into its Codex fallback without a caller capability', async () => {
    const calls: Array<{ provider: string; capabilities: string[] }> = [];
    const outcome = await dispatch(
      { taskClass: 'web-research', prompt: 'x', cwd: tempDir(), identity: unbound },
      tempLedger(),
      (provider) => ({ name: provider, provider: provider as WorkerAdapter['provider'], dispatch: async (_prompt, opts) => {
        calls.push({ provider, capabilities: opts.capabilities ?? [] });
        return provider === 'gemini'
          ? { ok: false, output: '', exitCode: 1, error: 'grounding failed' }
          : { ok: true, output: 'grounded fallback', exitCode: 0 };
      } }),
    );
    expect(outcome).toMatchObject({ ok: true, provider: 'codex', usedFallback: true, capabilities: ['browse'] });
    expect(calls).toEqual([
      { provider: 'gemini', capabilities: [] },
      { provider: 'codex', capabilities: ['browse'] },
    ]);
  });

  it('refuses an explicit web-research override to a provider without enforceable browse', async () => {
    const fake = fakeAdapter();
    const outcome = await dispatch(
      { taskClass: 'web-research', provider: 'cursor', model: 'composer-2.5', prompt: 'x', cwd: tempDir(), identity: unbound },
      tempLedger(),
      () => fake.adapter,
    );
    expect(outcome.refusal?.code).toBe('capability-denied');
    expect(fake.calls).toHaveLength(0);
  });

  it('a CLASS-declared exec-privileged capability still needs req.optIn — a class cannot self-grant it (gitar #76)', async () => {
    const cwd = tempDir(); const ledger = tempLedger();
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync } = await import('node:fs');
    // Operator gate ON, and a class that DECLARES exec-privileged as a class-default capability. The
    // union feeds decideCapabilities's `requested` list, but `optIn` still comes solely from req — so
    // the two-key gate holds and the class cannot self-grant it.
    writeFileSync(yamlPath, 'policy: {capabilities: {allow_exec_privileged: true}}\nproviders: {codex: {models: [gpt-5.6-luna], execution: headless}}\ntask_classes: {danger: {provider: codex, model: gpt-5.6-luna, capabilities: [exec-privileged]}}\n');
    const prev = process.env.HEDDLE_ROUTING;
    try {
      process.env.HEDDLE_ROUTING = yamlPath;
      const refused = await dispatch({ taskClass: 'danger', prompt: 'x', cwd, identity: unbound }, ledger, () => fakeAdapter({ ok: false, output: '', exitCode: null }).adapter);
      expect(refused.refusal?.code).toBe('capability-denied'); // no req.optIn → refused despite the class default + gate on
      const granted = await dispatch({ taskClass: 'danger', prompt: 'x', cwd, optIn: true, identity: unbound }, ledger, () => fakeAdapter().adapter);
      expect(granted.capabilities).toEqual(['exec-privileged']); // req.optIn is the second key; then the class default flows through
    } finally {
      if (prev === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = prev;
    }
  });

  it('an explicit provider/model INHERITS the class capability defaults — never silently dropped (cubic P1/codex #76)', async () => {
    const cwd = tempDir(); const ledger = tempLedger();
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync } = await import('node:fs');
    // A class whose PRIMARY declares a grantable default capability. Dispatching it with an explicit
    // provider/model must carry that default to the named target (like skills/mcp) — else the class
    // policy is silently shed on the explicit path.
    writeFileSync(yamlPath, 'policy: {}\nproviders: {codex: {models: [gpt-5.6-luna, gpt-5.6-sol], execution: headless}}\ntask_classes: {browsy: {provider: codex, model: gpt-5.6-luna, capabilities: [browse]}}\n');
    const prev = process.env.HEDDLE_ROUTING;
    try {
      process.env.HEDDLE_ROUTING = yamlPath;
      // Explicit provider/model under the class policy, no req.capabilities of its own.
      const out = await dispatch({ taskClass: 'browsy', provider: 'codex', model: 'gpt-5.6-sol', prompt: 'x', cwd, identity: unbound }, ledger, () => fakeAdapter().adapter);
      expect(out.capabilities).toEqual(['browse']); // inherited from the class default, not dropped
    } finally {
      if (prev === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = prev;
    }
  });

  it('dry run mirrors the requiresWeb refusal — planDispatch/summarizePlan never advertise a web route the run refuses (codex #76)', async () => {
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync } = await import('node:fs');
    // requiresWeb class whose primary can't web (codex, no browse grant, not gemini): the run refuses,
    // so the preview must not present it as runnable.
    writeFileSync(yamlPath, 'policy: {}\nproviders: {codex: {models: [gpt-5.6-luna], execution: headless}}\ntask_classes: {research: {provider: codex, model: gpt-5.6-luna, requires_web: true}}\n');
    const table = loadRouting(yamlPath);
    const plan = planDispatch({ taskClass: 'research', prompt: 'x', cwd: tempDir(), identity: unbound, caps: {} }, table);
    const summary = summarizePlan(plan);
    expect(plan.requiresWebRefusal, 'plan flags the web refusal').toBeTruthy();
    expect(summary.would_run, 'preview does not advertise a runnable route').toBeNull();
    expect((summary.refusal as { code?: string } | null)?.code).toBe('capability-denied');
  });

  it('dry run surfaces a TERMINAL capability refusal (unknown token) — never advertises a route the run refuses (cubic #76)', async () => {
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(yamlPath, 'policy: {}\nproviders: {codex: {models: [gpt-5.6-luna], execution: headless}}\ntask_classes: {plain: {provider: codex, model: gpt-5.6-luna}}\n');
    const table = loadRouting(yamlPath);
    // A bogus capability is a terminal unknown-token refusal (no capability-fit fallback), so the dry
    // run must show it — unlike `unenforceable`, which may fall back and run (HED-275).
    const plan = planDispatch({ taskClass: 'plain', capabilities: ['bogus'], prompt: 'x', cwd: tempDir(), identity: unbound, caps: {} }, table);
    const summary = summarizePlan(plan);
    expect(plan.capabilityRefusal, 'plan flags the terminal capability refusal').toBeTruthy();
    expect(summary.would_run).toBeNull();
    expect((summary.refusal as { code?: string } | null)?.code).toBe('capability-denied');
  });

  it('dry run does NOT surface a capability refusal for an in-session Claude route — dispatch returns the in-session instruction first (cubic #76)', async () => {
    const yamlPath = join(tempDir(), 'routing.yaml');
    const { writeFileSync } = await import('node:fs');
    // A Claude route run in-session returns the in-session instruction before runTarget's capability
    // gate, so a bad capability must NOT preview as a refusal (that would diverge from the run).
    writeFileSync(yamlPath, 'policy: {}\nproviders: {claude: {models: [sonnet], execution: headless}}\ntask_classes: {think: {provider: claude, model: sonnet}}\n');
    const table = loadRouting(yamlPath);
    const plan = planDispatch({ taskClass: 'think', capabilities: ['bogus'], inSession: true, prompt: 'x', cwd: tempDir(), identity: unbound, caps: {} }, table);
    const summary = summarizePlan(plan);
    expect(plan.capabilityRefusal, 'no capability refusal for in-session route').toBeFalsy();
    expect(summary.in_session).toBe(true);
    expect((summary.refusal as { code?: string } | null)?.code).not.toBe('capability-denied');
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
