import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dispatch, isNonReason, planDispatch } from '../src/dispatch.js';
import { Ledger, applyLedgerMigrations } from '../src/ledger.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

describe('dispatch — direct override reasons', () => {
  const { tempDir, tempLedger, trackLedger } = useTempResources('heddle-override-reason-test-');
  const { unbound } = IDENTITIES;

  it('refuses a bare direct dispatch, records its refusal, and names real task classes to use instead', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    const outcome = await dispatch({ provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);

    expect(outcome.refusal?.code).toBe('override-reason-required');
    expect(outcome.refusal?.instruction).toContain('codex/gpt-5.6-terra IS the fallback route of task class `implementation`');
    expect(outcome.refusal?.instruction).toContain('implementation');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)).toEqual([expect.objectContaining({ refusal: 'override-reason-required', task_class: 'direct:codex/gpt-5.6-terra' })]);
  });

  describe('regression PR#148 — junk direct override reasons', () => {
    it.each([
      'habit', 'proven', 'faster', 'fast', 'worked before', 'works', 'it works', 'default',
      'usual', 'preference', 'prefer', 'same as before', 'as usual', 'familiar',
      'terra proven', 'gpt-5.6-terra', 'x',
    ])('rejects %j after stripping the direct route identity', (reason) => {
      expect(isNonReason(reason, 'codex', 'gpt-5.6-terra')).toBe(true);
    });

    it.each([
      'proven for numbered specs',
      'terra is the only lineage that handled the recursive YAML edge last time',
      "proven approach won't parse",
    ])('accepts a specific justification: %j', (reason) => {
      expect(isNonReason(reason, 'codex', 'gpt-5.6-terra')).toBe(false);
    });

    it('refuses a junk reason and makes dispatch and plan_dispatch agree on the reason', async () => {
      const ledger = tempLedger(); const fake = fakeAdapter();
      const request = { provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound, overrideReason: 'terra proven' };
      const outcome = await dispatch(request, ledger, () => fake.adapter);
      const plan = planDispatch(request);

      expect(outcome.refusal).toMatchObject({ code: 'override-reason-required' });
      expect(plan.overrideReasonRequired).toBe(outcome.refusal?.reason);
      expect(plan.overrideReasonRequired).toContain("that's not a reason ('proven')");
      expect(fake.calls).toHaveLength(0);
    });
  });

  it('treats a whitespace-only direct override reason as missing and refuses before calling the adapter', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    const outcome = await dispatch({ provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound, overrideReason: '   ' }, ledger, () => fake.adapter);

    expect(outcome.refusal?.code).toBe('override-reason-required');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'override-reason-required', task_class: 'direct:codex/gpt-5.6-terra' });
  });

  it('runs an explained direct override and records its exact reason on the completed ledger row', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    const outcome = await dispatch({ provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound, overrideReason: 'bench: terra vs sol on this shape' }, ledger, () => fake.adapter);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.model).toBe('gpt-5.6-terra');
    expect(outcome.ok).toBe(true);
    expect(outcome.refusal).toBeUndefined();
    expect(ledger.recent(1)[0].override_reason).toBe('bench: terra vs sol on this shape');
  });

  it('trims a direct override reason before persisting it to the ledger', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    await dispatch({ provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound, overrideReason: '  spaced reason  ' }, ledger, () => fake.adapter);

    expect(ledger.recent(1)[0].override_reason).toBe('spaced reason');
  });

  it('runs class dispatches without a reason and records one when the caller provides it', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    const cwd = tempDir();
    const ordinary = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound }, ledger, () => fake.adapter);
    const explained = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound, overrideReason: 'why not' }, ledger, () => fake.adapter);

    expect(ordinary.ok).toBe(true);
    expect(ordinary.refusal).toBeUndefined();
    expect(explained.ok).toBe(true);
    expect(explained.refusal).toBeUndefined();
    const rows = ledger.recent(2);
    expect(rows[0]).toMatchObject({ task_class: 'bulk-mechanical', override_reason: 'why not' });
    expect(rows[1]).toMatchObject({ task_class: 'bulk-mechanical', override_reason: null });
  });

  it('keeps class policy in force when a class dispatch explicitly names a provider and model without a reason', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);

    expect(outcome).toMatchObject({ ok: true, taskClass: 'bulk-mechanical' });
    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(ledger.recent(1)[0]).toMatchObject({ task_class: 'bulk-mechanical', refusal: null, override_reason: null });
  });

  it('records the bare direct refusal before any worker or classifier can be spawned', async () => {
    const ledger = tempLedger(); const fake = fakeAdapter();
    fake.adapter.dispatch = async () => { throw new Error('the direct gate must prevent this worker from running'); };
    const outcome = await dispatch({ provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);

    expect(outcome.refusal?.code).toBe('override-reason-required');
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'override-reason-required', task_class: 'direct:codex/gpt-5.6-terra', finished_at: expect.any(String) });
  });

  it('reopens an already migrated ledger and safely reapplies migrations while preserving override reasons', () => {
    const path = join(tempDir(), 'ledger.db');
    const first = trackLedger(new Ledger(path));
    first.close();
    const db = new DatabaseSync(path);
    expect(() => {
      applyLedgerMigrations(db, new Set());
      applyLedgerMigrations(db, new Set());
    }).not.toThrow();
    db.close();

    const second = trackLedger(new Ledger(path));
    const id = second.start({
      orchestrator: null, taskClass: 'direct:codex/gpt-5.6-terra', provider: 'codex', model: 'gpt-5.6-terra', skills: null,
      issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'x', sessionId: null, fellBackFrom: null,
      overrideReason: 'survives reopen',
    });

    expect(id).toBeTypeOf('number');
    expect(second.recent(1)[0]).toMatchObject({ task_class: 'direct:codex/gpt-5.6-terra', override_reason: 'survives reopen' });
  });
});
