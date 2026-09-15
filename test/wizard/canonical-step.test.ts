import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFleetHooks } from '../../src/fleet.js';
import { planInstall } from '../../src/init-project.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';

const hooks = ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py'];
const fleetMock = vi.hoisted(() => ({ install: vi.fn(), real: undefined as undefined | typeof import('../../src/fleet.js').installFleetHooks }));

vi.mock('../../src/fleet.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/fleet.js')>('../../src/fleet.js');
  fleetMock.real = actual.installFleetHooks;
  fleetMock.install.mockImplementation(actual.installFleetHooks);
  return { ...actual, installFleetHooks: fleetMock.install };
});

import { canonicalStep } from '../../src/wizard/canonical-step.js';

describe('canonicalStep', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.stubEnv('HEDDLE_CANONICAL', undefined);
    fleetMock.install.mockClear();
    fleetMock.install.mockImplementation(fleetMock.real!);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function home(): string {
    const value = mkdtempSync(join(tmpdir(), 'heddle-canonical-step-'));
    homes.push(value);
    return value;
  }
  function seedCanon(base: string, names = hooks): string {
    const canonicalDir = join(base, 'canon', 'hooks');
    mkdirSync(canonicalDir, { recursive: true });
    for (const hook of names) writeFileSync(join(canonicalDir, hook), '#!/usr/bin/env python3\n');
    return canonicalDir;
  }
  function context(homeDir: string, dryRun = false): WizardContext {
    return { homeDir, dryRun, now: () => new Date(0), results: new Map() };
  }
  function io(answers: unknown[], reports: string[]): WizardIO {
    return { prompter: new ScriptedPrompter(answers), report: (line) => reports.push(line) };
  }
  function useSource(canonicalDir: string): void {
    fleetMock.install.mockImplementation((options = {}) => fleetMock.real!({ ...options, canonicalDir }));
  }

  it('records the installed fleet canonical so init-project resolves without a canonical flag', async () => {
    const homeDir = home();
    useSource(seedCanon(homeDir));

    await expect(canonicalStep.run(context(homeDir), io([true], []))).resolves.toMatchObject({ status: 'done' });

    const target = join(homeDir, 'project');
    mkdirSync(target);
    expect(planInstall({ dir: target, homeDir, name: 'toy', team: 'NEW', agents: 'Z', room: '#toy', launcher: 'resume-toy.sh' }).options.canonical)
      .toBe(realpathSync.native(join(homeDir, '.heddle', 'fleet')));
  });

  it('records a valid environment override without installing hooks', async () => {
    const homeDir = home();
    const override = seedCanon(homeDir);
    vi.stubEnv('HEDDLE_CANONICAL', join(override, '..'));

    await canonicalStep.run(context(homeDir), io([], []));

    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'canonical.json'), 'utf8'))).toEqual({ canonical: realpathSync.native(join(override, '..')) });
    expect(fleetMock.install).not.toHaveBeenCalled();
  });

  it('leaves canonical unrecorded for a fleetless pack', async () => {
    const homeDir = home();
    useSource(join(homeDir, 'no-fleet', 'hooks'));
    const reports: string[] = [];

    await expect(canonicalStep.run(context(homeDir), io([true], reports))).resolves.toMatchObject({ status: 'skipped', summary: expect.stringMatching(/ships no discipline hooks/) });

    expect(reports.join('\n')).toMatch(/ships no discipline hooks/);
    expect(existsSync(join(homeDir, '.heddle', 'canonical.json'))).toBe(false);
  });

  it('fails without writing config when the installed canon remains partial', async () => {
    const homeDir = home();
    useSource(seedCanon(homeDir, hooks.slice(0, -1)));

    await expect(canonicalStep.run(context(homeDir), io([true], []))).resolves.toMatchObject({ status: 'failed', summary: expect.stringMatching(/require-pr-sweep\.py/) });

    expect(existsSync(join(homeDir, '.heddle', 'canonical.json'))).toBe(false);
  });

  it('keeps an already-valid canonical configuration unchanged', async () => {
    const homeDir = home();
    const canonical = join(seedCanon(homeDir), '..');
    const config = join(homeDir, '.heddle', 'canonical.json');
    mkdirSync(join(homeDir, '.heddle'), { recursive: true });
    writeFileSync(config, `${JSON.stringify({ canonical, preserved: true }, null, 2)}\n`);

    await expect(canonicalStep.run(context(homeDir), io([], []))).resolves.toMatchObject({ status: 'done', summary: `kept canonical ${realpathSync.native(canonical)}` });

    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ canonical, preserved: true });
  });

  it('dry-runs without installing or recording and discloses planned actions', async () => {
    const homeDir = home();
    useSource(seedCanon(homeDir));
    const reports: string[] = [];

    await expect(canonicalStep.run(context(homeDir, true), io([], reports))).resolves.toMatchObject({ status: 'skipped' });

    expect(fleetMock.install).toHaveBeenCalledWith(expect.objectContaining({ homeDir, dryRun: true, skipDiffering: true }));
    expect(reports.join('\n')).toMatch(/would .*agent-identity\.py/);
    expect(existsSync(join(homeDir, '.heddle', 'canonical.json'))).toBe(false);
  });

  it('does not record canonical when installation is declined and hooks are absent', async () => {
    const homeDir = home();

    await expect(canonicalStep.run(context(homeDir), io([false], []))).resolves.toMatchObject({ status: 'skipped', summary: expect.stringMatching(/install declined/) });

    expect(existsSync(join(homeDir, '.heddle', 'canonical.json'))).toBe(false);
  });
});
