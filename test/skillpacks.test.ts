import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
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
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    ledgers.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-skillpacks-test-'));
    dirs.push(dir);
    return dir;
  }

  function fakeAdapter(onDispatch: (cwd: string) => void): WorkerAdapter {
    return {
      name: 'fake',
      provider: 'codex',
      dispatch: async (_prompt, opts) => {
        onDispatch(opts.cwd);
        return { ok: true, output: 'done', exitCode: 0 };
      },
    };
  }

  it('materializes caller skills together with worker-role and restores AGENTS.md after a direct dispatch', async () => {
    const cwd = tempDir();
    const ledger = new Ledger(join(tempDir(), 'ledger.db'));
    ledgers.push(ledger);
    let agentsDuringDispatch = '';
    const adapter = fakeAdapter((workerCwd) => { agentsDuringDispatch = readFileSync(join(workerCwd, 'AGENTS.md'), 'utf8'); });

    const outcome = await dispatch(
      { provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd, skills: ['quality-gate'], orchestrator: 'U' },
      ledger,
      () => adapter,
    );

    expect(agentsDuringDispatch).toContain('### worker-role');
    expect(agentsDuringDispatch).toContain('### quality-gate');
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    const [row] = ledger.recent(1);
    expect(row.skills).toBe('worker-role,quality-gate');
    expect(row.task_class).toBe('direct:codex/gpt-5.6-luna');
    expect(row.ok).toBe(1);
    expect(outcome.skills).toEqual(['worker-role', 'quality-gate']);
  });

  it('unions worker-role into routing defaults before materializing a bulk-mechanical dispatch', async () => {
    const cwd = tempDir();
    const ledger = new Ledger(join(tempDir(), 'ledger.db'));
    ledgers.push(ledger);
    let agentsDuringDispatch = '';
    const adapter = fakeAdapter((workerCwd) => { agentsDuringDispatch = readFileSync(join(workerCwd, 'AGENTS.md'), 'utf8'); });

    await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd }, ledger, () => adapter);

    expect(agentsDuringDispatch).toContain('### worker-role');
    expect(agentsDuringDispatch).toContain('### quality-gate');
    const [row] = ledger.recent(1);
    expect(row.skills).toBe('worker-role,quality-gate');
    expect(row.task_class).toBe('bulk-mechanical');
  });
});
