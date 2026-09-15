import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));

import { PROJECTS_SCHEMA_VERSION } from '../../src/projects.js';
import { LinShLinearRunner, linearStep, type LinearRunner } from '../../src/wizard/linear-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

type RunnerReply = { ok: boolean; identity?: string; name?: string; error?: string };

class StubLinearRunner implements LinearRunner {
  readonly calls: string[] = [];

  constructor(
    private readonly state: {
      installed?: boolean;
      agents?: Record<string, RunnerReply>;
      team?: RunnerReply;
    } = {},
  ) {}

  installed(): boolean {
    return this.state.installed ?? true;
  }

  async whoami(agent: string): Promise<{ ok: boolean; identity?: string; error?: string }> {
    this.calls.push(`whoami:${agent}`);
    const reply = this.state.agents?.[agent] ?? { ok: true, identity: `synthetic-${agent}` };
    return { ok: reply.ok, identity: reply.identity, error: reply.error };
  }

  async team(teamKey: string, agent: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    this.calls.push(`team:${teamKey}:${agent}`);
    const reply = this.state.team ?? { ok: true, name: teamKey };
    return { ok: reply.ok, name: reply.name, error: reply.error };
  }
}

function context(homeDir: string, targetDir: string, dryRun = false): WizardContext {
  return { homeDir, targetDir, dryRun, now: () => new Date(0), results: new Map() };
}

function io(answers: unknown[], reports: string[] = []): WizardIO {
  return { prompter: new ScriptedPrompter(answers), report: (line) => reports.push(line) };
}

function writeRegistry(homeDir: string, targetDir: string, agents = ['A', 'B'], team = 'HED'): void {
  const registryDir = join(homeDir, '.heddle');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'projects.json'), JSON.stringify({
    schemaVersion: PROJECTS_SCHEMA_VERSION,
    projects: [{
      name: 'synthetic-project', workspaceRoots: [targetDir], agentIds: agents, linearTeam: team,
      defaultRoom: 'synthetic-room', launcher: 'synthetic-launcher',
    }],
  }));
}

describe('linearStep', () => {
  const { tempDir } = useTempResources('hed645-linear-step-');

  function registered(agents = ['A', 'B'], team = 'HED'): { homeDir: string; targetDir: string } {
    const homeDir = tempDir();
    const targetDir = tempDir();
    writeRegistry(homeDir, targetDir, agents, team);
    return { homeDir, targetDir };
  }

  it('skips explicitly without running the adapter or writing the target', async () => {
    const { homeDir, targetDir } = registered();
    const runner = new StubLinearRunner();
    const before = readdirSync(targetDir);

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([false]));

    expect(result).toMatchObject({ id: 'linear', status: 'skipped', summary: expect.stringContaining('re-run `heddle setup` anytime') });
    expect(runner.calls).toEqual([]);
    expect(readdirSync(targetDir)).toEqual(before);
  });

  it('guides installation without spawning when lin.sh is absent', async () => {
    const { homeDir, targetDir } = registered();
    const runner = new StubLinearRunner({ installed: false });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('heddle fleet install-bin');
    expect(runner.calls).toEqual([]);
  });

  it('verifies every roster agent in order before checking the team with a verified identity', async () => {
    const { homeDir, targetDir } = registered(['A', 'B'], 'HED');
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('done');
    expect(runner.calls).toEqual(['whoami:A', 'whoami:B', 'team:HED:A']);
    expect(result.detail).toContain('VERIFIED: agents A, B');
    expect(result.detail).toContain('VERIFIED: team HED');
    expect(result.detail).toContain('STILL MANUAL: export LIN_TEAM=HED');
  });

  it('stops at a missing credential store and provides provisioning guidance', async () => {
    const { homeDir, targetDir } = registered(['A', 'B']);
    const runner = new StubLinearRunner({ agents: { A: { ok: false, error: 'credentials not set up' } } });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('Provision Linear OAuth agent credentials');
    expect(runner.calls).toEqual(['whoami:A']);
  });

  it('continues past an unknown agent key and guides only that agent', async () => {
    const { homeDir, targetDir } = registered(['A', 'B', 'C']);
    const runner = new StubLinearRunner({ agents: { B: { ok: false, error: 'unknown agent key B' } } });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(runner.calls).toEqual(['whoami:A', 'whoami:B', 'whoami:C', 'team:HED:A']);
    expect(result.detail).toContain('Agent B has no Linear OAuth app');
    expect(result.detail).not.toContain('Agent A has no Linear OAuth app');
    expect(result.detail).not.toContain('Agent C has no Linear OAuth app');
  });

  it('surfaces an agent timeout without misclassifying it as missing OAuth', async () => {
    const { homeDir, targetDir } = registered(['A', 'B']);
    const runner = new StubLinearRunner({ agents: { B: { ok: false, error: 'request timed out (401)' } } });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('request timed out (401)');
    expect(result.detail).not.toContain('Agent B has no Linear OAuth app');
  });

  it('carries the real inaccessible-team error in its guide', async () => {
    const { homeDir, targetDir } = registered(['A'], 'HED');
    const runner = new StubLinearRunner({ team: { ok: false, error: 'team endpoint returned 403' } });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('team endpoint returned 403');
    expect(runner.calls).toEqual(['whoami:A', 'team:HED:A']);
  });

  it('does not spawn lin.sh in dry-run after resolving the target-local registry', async () => {
    const targetDir = tempDir();
    const homeDir = targetDir;
    writeRegistry(homeDir, targetDir, ['A'], 'HED');
    const runner = new StubLinearRunner();
    const before = readdirSync(targetDir);

    const result = await linearStep(runner).run(context(homeDir, targetDir, true), io([true]));

    expect(result).toMatchObject({ status: 'skipped', summary: expect.stringContaining('dry-run — would verify credential/team/roster for team HED, agents A') });
    expect(runner.calls).toEqual([]);
    expect(readdirSync(targetDir)).toEqual(before);
  });

  it('re-prompts an unregistered target once for a blank team then fails with a guide', async () => {
    const homeDir = tempDir();
    const targetDir = tempDir();
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true, '  ', '']));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('team key must not be blank');
    expect(runner.calls).toEqual([]);
  });

  it('prompts an unregistered target for its team and roster', async () => {
    const homeDir = tempDir();
    const targetDir = tempDir();
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true, 'HED', 'C, D']));

    expect(result.status).toBe('done');
    expect(runner.calls).toEqual(['whoami:C', 'whoami:D', 'team:HED:C']);
  });

  it('guides an empty roster without a bare whoami fallback', async () => {
    const homeDir = tempDir();
    const targetDir = tempDir();
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true, 'HED', '']));

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('provide at least one agent to verify Linear');
    expect(runner.calls).toEqual([]);
  });

  it('rejects a blank registered team before spawning', async () => {
    const { homeDir, targetDir } = registered(['A'], '   ');
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/team key must not be blank/i);
    expect(runner.calls).toEqual([]);
  });

  it('rejects a leading-dash registered agent before spawning', async () => {
    const { homeDir, targetDir } = registered(['-A'], 'HED');
    const runner = new StubLinearRunner();

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(runner.calls).toEqual([]);
  });

  it('does not check the team when every roster agent fails', async () => {
    const { homeDir, targetDir } = registered(['A', 'B']);
    const runner = new StubLinearRunner({
      agents: {
        A: { ok: false, error: 'unknown agent key A' },
        B: { ok: false, error: 'unknown agent key B' },
      },
    });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(runner.calls).toEqual(['whoami:A', 'whoami:B']);
    expect(result.detail).toMatch(/No roster agent verified/i);
  });

  it('uses the first verified agent for the team check', async () => {
    const { homeDir, targetDir } = registered(['A', 'B']);
    const runner = new StubLinearRunner({ agents: { A: { ok: false, error: 'unknown agent key A' } } });

    const result = await linearStep(runner).run(context(homeDir, targetDir), io([true]));

    expect(result.status).toBe('failed');
    expect(runner.calls).toEqual(['whoami:A', 'whoami:B', 'team:HED:B']);
  });

  it('does not let a throwing reporter change a verified result', async () => {
    const { homeDir, targetDir } = registered(['A']);
    const throwingIo: WizardIO = {
      prompter: new ScriptedPrompter([true]),
      report: () => { throw new Error('report boom'); },
    };

    await expect(linearStep(new StubLinearRunner()).run(context(homeDir, targetDir), throwingIo)).resolves.toMatchObject({ status: 'done' });
  });

  it('returns a JSON-serializable WizardStepResult shape', async () => {
    const { homeDir, targetDir } = registered(['A']);
    const result = await linearStep(new StubLinearRunner()).run(context(homeDir, targetDir), io([true]));

    const json = JSON.parse(JSON.stringify(result));
    expect(Object.keys(json).sort()).toEqual(['detail', 'id', 'status', 'summary']);
    expect(json).toMatchObject({ id: 'linear', status: 'done' });
  });
});

describe('LinShLinearRunner', () => {
  afterEach(() => mockExecFileSync.mockReset());

  it('uses scoped argv and LIN_TEAM only for the team probe', async () => {
    mockExecFileSync.mockReturnValue('identity  : synthetic\n');
    const runner = new LinShLinearRunner('/synthetic-home');

    await runner.whoami('A');
    await runner.team('SYN', 'A');

    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, join('/synthetic-home', '.heddle', 'fleet', 'bin', 'lin.sh'), ['--agent', 'A', 'whoami'], expect.objectContaining({ timeout: 15_000, encoding: 'utf8' }));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, join('/synthetic-home', '.heddle', 'fleet', 'bin', 'lin.sh'), ['--agent', 'A', 'list', '--limit', '1'], expect.objectContaining({ env: expect.objectContaining({ LIN_TEAM: 'SYN' }), timeout: 15_000, encoding: 'utf8' }));
    expect((mockExecFileSync.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env.LIN_TEAM).not.toBe('SYN');
  });

  it('refuses unsafe agents and blank teams without spawning', async () => {
    const runner = new LinShLinearRunner('/synthetic-home');

    await expect(runner.whoami(' ')).rejects.toThrow('agent key');
    await expect(runner.whoami('-A')).rejects.toThrow('agent key');
    await expect(runner.team('  ', 'A')).rejects.toThrow('team key');
    await expect(runner.team('HED', '-A')).rejects.toThrow('agent key');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
