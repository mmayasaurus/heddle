import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { useTempResources, fakeAdapter } from './helpers.js';
import { MANDATORY_PACKS, listPacks, withMandatoryPacks } from '../src/skillpacks.js';
import type { WorkerAdapter } from '../src/types.js';

describe('skill packs — mandatory union rule', () => {
  it('adds worker-role when skills are omitted or explicitly empty', () => {
    expect(withMandatoryPacks(undefined)).toEqual(['worker-role']);
    expect(withMandatoryPacks([])).toEqual(['worker-role']);
  });

  it('places worker-role first before a requested task-fit pack', () => {
    expect(withMandatoryPacks(['quality-gate'])).toEqual(['worker-role', 'quality-gate']);
  });

  it('moves a requested worker-role to the front without duplicating it', () => {
    expect(withMandatoryPacks(['quality-gate', 'worker-role'])).toEqual(['worker-role', 'quality-gate']);
  });

  it('preserves the first requested occurrence order while de-duplicating packs', () => {
    expect(withMandatoryPacks(['b', 'a', 'b'])).toEqual(['worker-role', 'b', 'a']);
  });

  it('does not mutate the caller array while constructing the mandatory union', () => {
    const requested = ['b', 'a', 'b'];
    withMandatoryPacks(requested);
    expect(requested).toEqual(['b', 'a', 'b']);
  });

  it('declares worker-role as the mandatory pack and ships a file for every mandatory pack', () => {
    expect(MANDATORY_PACKS).toEqual(['worker-role']);
    const packs = listPacks();
    for (const mandatory of MANDATORY_PACKS) expect(packs).toContain(mandatory);
  });
});

describe('dispatch — mandatory skill materialization', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-skillpacks-test-');

  it('materializes caller skills together with worker-role and restores AGENTS.md after a direct dispatch', async () => {
    const cwd = tempDir();
    const ledger = tempLedger();
    const fake = fakeAdapter();
    const adapter = fake.adapter;

    const outcome = await dispatch(
      { provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd, skills: ['quality-gate'], orchestrator: 'U' },
      ledger,
      () => adapter,
    );

    expect(fake.calls[0].agents).toContain('### worker-role');
    expect(fake.calls[0].agents).toContain('### quality-gate');
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    const [row] = ledger.recent(1);
    expect(row.skills).toBe('worker-role,quality-gate');
    expect(row.task_class).toBe('direct:codex/gpt-5.6-luna');
    expect(row.ok).toBe(1);
    expect(outcome.skills).toEqual(['worker-role', 'quality-gate']);
  });

  it('unions worker-role into routing defaults before materializing a bulk-mechanical dispatch', async () => {
    const cwd = tempDir();
    const ledger = tempLedger();
    const fake = fakeAdapter();
    const adapter = fake.adapter;

    await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd }, ledger, () => adapter);

    expect(fake.calls[0].agents).toContain('### worker-role');
    expect(fake.calls[0].agents).toContain('### quality-gate');
    const [row] = ledger.recent(1);
    expect(row.skills).toBe('worker-role,quality-gate');
    expect(row.task_class).toBe('bulk-mechanical');
  });
});

describe('dispatch — fallback carries the class packs', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-skillpacks-fallback-test-');

  it('materializes the bulk-mechanical packs again when its fallback is dispatched', async () => {
    const cwd = tempDir();
    const ledger = tempLedger();
    const calls: { model: string; agents: string }[] = [];
    const adapter: WorkerAdapter = {
      name: 'fake', provider: 'codex',
      dispatch: async (_prompt, opts) => {
        calls.push({ model: opts.model, agents: readFileSync(join(opts.cwd, 'AGENTS.md'), 'utf8') });
        return calls.length === 1
          ? { ok: false, output: '', exitCode: 1, error: 'primary down' }
          : { ok: true, output: 'done', exitCode: 0 };
      },
    };

    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd }, ledger, () => adapter);

    expect(calls).toHaveLength(2);
    expect(calls[1].model).toBe('composer-2.5-fast');
    expect(calls[1].agents).toContain('### quality-gate');
    expect(calls[1].agents).toContain('### worker-role');
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.skills).toEqual(['worker-role', 'quality-gate']);
    expect(ledger.recent(2)[0]).toMatchObject({ fell_back_from: 'codex/gpt-5.6-luna', skills: 'worker-role,quality-gate' });
  });
});
