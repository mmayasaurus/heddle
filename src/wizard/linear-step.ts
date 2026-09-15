import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectRegistry, projectForCwd, type Project } from '../projects.js';
import type { WizardIO, WizardStep, WizardStepResult } from './step.js';

/** A narrow seam around the installed Linear command. */
export interface LinearRunner {
  installed(): boolean;
  whoami(agent: string): Promise<{ ok: boolean; identity?: string; error?: string }>;
  team(teamKey: string, agent: string): Promise<{ ok: boolean; name?: string; error?: string }>;
}

class InvalidLinearProbeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLinearProbeInputError';
  }
}

type CommandResult = { ok: boolean; output: string; error?: string };

/** Production adapter for the fleet-owned Linear command. */
export class LinShLinearRunner implements LinearRunner {
  private readonly script: string;

  constructor(homeDir: string) {
    this.script = join(homeDir, '.heddle', 'fleet', 'bin', 'lin.sh');
  }

  installed(): boolean {
    return existsSync(this.script);
  }

  async whoami(agent: string): Promise<{ ok: boolean; identity?: string; error?: string }> {
    validateAgent(agent);
    const result = this.run(['--agent', agent, 'whoami']);
    if (!result.ok) return { ok: false, error: result.error ?? 'lin.sh whoami failed' };
    const identity = /^identity\s*:\s*(.+)$/mi.exec(result.output)?.[1]?.trim();
    return { ok: true, identity: identity || undefined };
  }

  async team(teamKey: string, agent: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    validateTeam(teamKey);
    validateAgent(agent);
    const result = this.run(['--agent', agent, 'list', '--limit', '1'], { LIN_TEAM: teamKey.trim() });
    return result.ok
      ? { ok: true, name: teamKey.trim() }
      : { ok: false, error: result.error ?? `could not reach Linear team ${teamKey.trim()}` };
  }

  private run(args: string[], env: NodeJS.ProcessEnv = {}): CommandResult {
    try {
      const output = execFileSync(this.script, args, {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 15_000,
      });
      return { ok: true, output };
    } catch (error) {
      const child = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const output = [child.stdout, child.stderr]
        .filter((value): value is string | Buffer => typeof value === 'string' || Buffer.isBuffer(value))
        .map(String)
        .join('\n');
      return { ok: false, output, error: output.trim() || (typeof child.message === 'string' ? child.message : String(error)) };
    }
  }
}

function validateAgent(agent: string): void {
  if (!agent.trim() || agent.trim().startsWith('-')) {
    throw new InvalidLinearProbeInputError('Linear agent key must be non-blank and must not begin with "-"');
  }
}

function validateTeam(teamKey: string): void {
  if (!teamKey.trim()) throw new InvalidLinearProbeInputError('Linear team key must not be blank');
}

function registryPath(homeDir: string): string {
  return join(homeDir, '.heddle', 'projects.json');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function provisionGuide(): string {
  return 'GUIDE: Provision Linear OAuth agent credentials, then re-run `heddle setup`.';
}

function oauthGuide(agent: string): string {
  return `GUIDE: Agent ${agent} has no Linear OAuth app. A Linear workspace admin must provision an OAuth app for that agent, then re-run \`heddle setup\`.`;
}

function manualSteps(teamKey: string): string {
  return `STILL MANUAL: export LIN_TEAM=${teamKey} in the launcher.`;
}

function isMissingCredentialStore(error: string): boolean {
  return /credentials?\s+not\s+set\s+up|missing .* credentials|linear-agents\.json/i.test(error);
}

function isUnknownAgent(error: string): boolean {
  return /unknown agent key/i.test(error);
}

type LinearProject = Pick<Project, 'linearTeam' | 'agentIds'>;

async function enteredProject(io: WizardIO): Promise<LinearProject | null> {
  let teamKey = (await io.prompter.text('Linear team key for this project')).trim();
  if (!teamKey) teamKey = (await io.prompter.text('Linear team key must not be blank; enter it again')).trim();
  if (!teamKey) return null;

  const enteredRoster = await io.prompter.text('Comma-separated Linear agent roster for this project');
  const agentIds = enteredRoster.trim() ? enteredRoster.split(',').map((agent) => agent.trim()) : [];
  return { linearTeam: teamKey, agentIds };
}

/**
 * A project-scoped, verification-only onboarding step. It writes no project or credential data
 * itself, but its live whoami/list probes cause lin.sh to mint a token cache (a side effect), which
 * is why dry-run skips them; do not drop that gate.
 */
export function linearStep(injectedRunner?: LinearRunner): WizardStep {
  return {
    id: 'linear',
    title: 'Linear onboarding',
    applies: (ctx) => !!ctx.targetDir,
    async run(ctx, io): Promise<WizardStepResult> {
      const skip = (summary: string, detail?: string): WizardStepResult => ({ id: 'linear', status: 'skipped', summary, ...(detail ? { detail } : {}) });
      const fail = (summary: string, detail: string): WizardStepResult => ({ id: 'linear', status: 'failed', summary, detail });
      const report = (result: WizardStepResult): WizardStepResult => {
        if (result.detail) {
          try {
            io.report(result.detail);
          } catch {
            // Reporting is observational; it must never change the verification result.
          }
        }
        return result;
      };

      let proceed: boolean;
      try {
        proceed = await io.prompter.confirm('Set up / verify Linear for this project now?');
      } catch (error) {
        return report(fail('Linear setup could not be confirmed', `GUIDE: Linear confirmation failed: ${errorText(error)}`));
      }
      if (!proceed) return skip('Linear setup skipped — re-run `heddle setup` anytime.');

      const runner = injectedRunner ?? new LinShLinearRunner(ctx.homeDir);
      let installed: boolean;
      try {
        installed = runner.installed();
      } catch (error) {
        const detail = `${provisionGuide()}\nGUIDE: Could not inspect the Linear command: ${errorText(error)}`;
        return report(skip('Linear tooling is unavailable; setup remains optional', detail));
      }
      if (!installed) {
        const detail = 'GUIDE: Install the fleet CLI with `heddle fleet install-bin`, then re-run `heddle setup`.';
        return report(skip('Linear tooling is unavailable; setup remains optional', detail));
      }

      let project: LinearProject | null;
      try {
        const registered = ctx.targetDir ? projectForCwd(loadProjectRegistry(registryPath(ctx.homeDir)), ctx.targetDir) : null;
        project = registered ?? await enteredProject(io);
      } catch (error) {
        return report(fail('Linear project configuration could not be resolved', `GUIDE: Could not resolve this project's Linear registry entry: ${errorText(error)}`));
      }
      if (!project) {
        return report(fail('Linear project configuration needs attention', 'GUIDE: Linear team key must not be blank; re-run `heddle setup` and provide a team key.'));
      }

      try {
        validateTeam(project.linearTeam);
        for (const agent of project.agentIds) validateAgent(agent);
      } catch (error) {
        return report(fail('Linear project configuration needs attention', `GUIDE: ${errorText(error)}`));
      }

      if (ctx.dryRun) {
        return skip(`dry-run — would verify credential/team/roster for team ${project.linearTeam}, agents ${project.agentIds.join(', ') || 'none'}`);
      }

      if (project.agentIds.length === 0) {
        return report(fail('Linear project configuration needs attention', 'GUIDE: provide at least one agent to verify Linear.'));
      }

      const detail: string[] = [];
      const verifiedAgents: string[] = [];
      let missingStore = false;
      let agentFailure = false;

      for (const agent of project.agentIds) {
        let check: { ok: boolean; identity?: string; error?: string };
        try {
          check = await runner.whoami(agent);
        } catch (error) {
          check = { ok: false, error: errorText(error) };
        }
        if (check.ok) {
          verifiedAgents.push(agent);
          continue;
        }
        const message = check.error ?? 'lin.sh whoami failed';
        if (isMissingCredentialStore(message)) {
          missingStore = true;
          detail.push(provisionGuide());
          break;
        }
        agentFailure = true;
        detail.push(isUnknownAgent(message) ? oauthGuide(agent) : `GUIDE: Linear check for agent ${agent} failed: ${message}`);
      }

      if (missingStore) {
        detail.push(manualSteps(project.linearTeam));
        return report(skip('Linear credentials need provisioning', detail.join('\n')));
      }

      if (verifiedAgents.length > 0) detail.unshift(`VERIFIED: agents ${verifiedAgents.join(', ')}`);
      let teamOk = false;
      if (verifiedAgents.length > 0) {
        let team: { ok: boolean; name?: string; error?: string };
        try {
          team = await runner.team(project.linearTeam, verifiedAgents[0]);
        } catch (error) {
          team = { ok: false, error: errorText(error) };
        }
        if (team.ok) {
          teamOk = true;
          detail.push(`VERIFIED: team ${team.name ?? project.linearTeam}`);
        } else {
          agentFailure = true;
          detail.push(`GUIDE: Linear team ${project.linearTeam} could not be verified: ${team.error ?? 'lin.sh list failed'}`);
        }
      } else {
        agentFailure = true;
        detail.push('GUIDE: No roster agent verified, so the Linear team could not be checked.');
      }

      detail.push(manualSteps(project.linearTeam));
      const allVerified = !agentFailure && teamOk && verifiedAgents.length === project.agentIds.length;
      const summary = allVerified
        ? `Linear verified: team ${project.linearTeam}, agents ${verifiedAgents.join(', ')}`
        : `Linear verification incomplete: ${verifiedAgents.length}/${project.agentIds.length} agents verified; team ${teamOk ? 'verified' : 'needs attention'}`;
      return report(allVerified ? { id: 'linear', status: 'done', summary, detail: detail.join('\n') } : fail(summary, detail.join('\n')));
    },
  };
}
