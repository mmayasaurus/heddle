import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECTS_SCHEMA_VERSION } from '../../src/projects.js';
import { linearStep, type LinearRunner } from '../../src/wizard/linear-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

type StubState = {
  available?: boolean;
  credential?: boolean;
  team?: boolean;
  agents?: Record<string, boolean>;
};

class StubLinearRunner implements LinearRunner {
  readonly calls: string[] = [];

  constructor(private readonly state: StubState = {}) {}

  available(): boolean {
    this.calls.push('available');
    return this.state.available ?? true;
  }

  async whoami(agent?: string): Promise<{ ok: boolean; identity?: string; error?: string }> {
    this.calls.push(`whoami:${agent ?? 'default'}`);
    const ok = agent ? (this.state.agents?.[agent] ?? true) : (this.state.credential ?? true);
    return ok ? { ok: true, identity: agent ? `synthetic-${agent}` : 'synthetic-operator' } : { ok: false, error: 'synthetic credential failure' };
  }

  async team(teamKey: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    this.calls.push(`team:${teamKey}`);
    return this.state.team ?? true ? { ok: true, name: teamKey } : { ok: false, error: 'synthetic team failure' };
  }
}

function context(targetDir: string, dryRun = false): WizardContext {
  return { homeDir: '/unused', targetDir, dryRun, now: () => new Date(0), results: new Map() };
}

function io(answers: unknown[], reports: string[] = []): WizardIO {
  return { prompter: new ScriptedPrompter(answers), report: (line) => reports.push(line) };
}

function registry(path: string, targetDir: string, agents = ['A', 'B'], team = 'TEST'): void {
  writeFileSync(path, JSON.stringify({
    schemaVersion: PROJECTS_SCHEMA_VERSION,
    projects: [{
      name: 'synthetic-project', workspaceRoots: [targetDir], agentIds: agents, linearTeam: team,
      defaultRoom: 'synthetic-room', launcher: 'synthetic-launcher',
    }],
  }));
}

describe('linearStep', () => {
  const { tempDir } = useTempResources('hed645-linear-step-');
  const originalProjects = process.env.HEDDLE_PROJECTS;

  afterEach(() => {
    if (originalProjects === undefined) delete process.env.HEDDLE_PROJECTS;
    else process.env.HEDDLE_PROJECTS = originalProjects;
  });

  function registered(agents = ['A', 'B'], team = 'TEST'): { targetDir: string; runner: StubLinearRunner } {
    const targetDir = tempDir();
    const projects = join(tempDir(), 'projects.json');
    registry(projects, targetDir, agents, team);
    process.env.HEDDLE_PROJECTS = projects;
    return { targetDir, runner: new StubLinearRunner() };
  }

  it('skips explicitly without checking Linear or writing the target', async () => {
    const { targetDir, runner } = registered();
    const before = readdirSync(targetDir);

    const result = await linearStep(runner).run(context(targetDir), io([false]));

    expect(result).toMatchObject({ id: 'linear', status: 'skipped', summary: expect.stringContaining('wizard works without it') });
    expect(runner.calls).toEqual([]);
    expect(readdirSync(targetDir)).toEqual(before);
  });

  it('guides when the fleet CLI is unavailable without writing', async () => {
    const { targetDir } = registered();
    const runner = new StubLinearRunner({ available: false });
    const reports: string[] = [];
    const before = readdirSync(targetDir);

    const result = await linearStep(runner).run(context(targetDir), io([true], reports));

    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('heddle fleet install-bin');
    expect(result.detail).toContain('lin.sh whoami');
    expect(reports.join('\n')).toContain('Provision Linear OAuth agent credentials');
    expect(runner.calls).toEqual(['available']);
    expect(readdirSync(targetDir)).toEqual(before);
  });

  it('reports verified credential, team, and roster', async () => {
    const { targetDir, runner } = registered(['A', 'B'], 'TEST');

    const result = await linearStep(runner).run(context(targetDir), io([true]));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('credential');
    expect(result.summary).toContain('team TEST');
    expect(result.summary).toContain('roster A, B');
    expect(result.detail).toContain('VERIFIED: credential');
    expect(result.detail).toContain('VERIFIED: team TEST');
    expect(result.detail).toContain('VERIFIED: roster A, B');
  });

  it('fails and gives the OAuth-app guide for an unprovisioned roster agent', async () => {
    const { targetDir } = registered(['A', 'B']);
    const runner = new StubLinearRunner({ agents: { A: true, B: false } });

    const result = await linearStep(runner).run(context(targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('Agent B has no Linear OAuth app');
    expect(result.detail).toContain('agents[B]');
    expect(result.detail).not.toContain('Agent A has no Linear OAuth app');
  });

  it('fails with a guide when the configured team is inaccessible', async () => {
    const { targetDir } = registered(['A'], 'TEST');
    const runner = new StubLinearRunner({ team: false });

    const result = await linearStep(runner).run(context(targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('Linear team TEST could not be reached');
    expect(result.detail).toContain('Confirm the team key and access');
  });

  it('runs the same read-only checks in dry-run mode', async () => {
    const { targetDir } = registered(['A'], 'TEST');
    const normal = new StubLinearRunner();
    const dry = new StubLinearRunner();
    const before = readdirSync(targetDir);

    const normalResult = await linearStep(normal).run(context(targetDir), io([true]));
    const dryResult = await linearStep(dry).run(context(targetDir, true), io([true]));

    expect(dryResult).toEqual(normalResult);
    expect(dry.calls).toEqual(normal.calls);
    expect(readdirSync(targetDir)).toEqual(before);
  });

  it('prompts for a team and roster when the target is unregistered', async () => {
    const targetDir = tempDir();
    const projects = join(tempDir(), 'empty-projects.json');
    writeFileSync(projects, JSON.stringify({ schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] }));
    process.env.HEDDLE_PROJECTS = projects;
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(targetDir), io([true, 'SYN', 'C, D']));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('team SYN');
    expect(result.summary).toContain('roster C, D');
    expect(runner.calls).toEqual(['available', 'whoami:default', 'team:SYN', 'whoami:C', 'whoami:D']);
  });

  it('returns a JSON-serializable WizardStepResult shape', async () => {
    const { targetDir, runner } = registered(['A']);

    const result = await linearStep(runner).run(context(targetDir), io([true]));
    const json = JSON.parse(JSON.stringify(result));

    expect(Object.keys(json).sort()).toEqual(['detail', 'id', 'status', 'summary']);
    expect(json).toMatchObject({ id: 'linear', status: 'done' });
  });
});
