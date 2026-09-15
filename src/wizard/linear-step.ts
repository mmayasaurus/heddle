import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROJECTS_PATH, loadProjectRegistry, projectForCwd, type Project } from '../projects.js';
import type { WizardIO, WizardStep, WizardStepResult } from './step.js';

/** Read-only seam around the installed fleet Linear CLI. */
export interface LinearRunner {
  available(): boolean;
  whoami(agent?: string): Promise<{ ok: boolean; identity?: string; error?: string }>;
  team(teamKey: string): Promise<{ ok: boolean; name?: string; error?: string }>;
}

type CommandResult = { ok: boolean; output: string; error?: string };

/**
 * Production adapter for the fleet-owned `lin.sh` command. It deliberately delegates credential
 * discovery to that command: its credential store is fleet-owned and must not be duplicated here.
 */
export class LinShLinearRunner implements LinearRunner {
  private readonly script: string;

  constructor(home = homedir()) {
    // Keep this in sync with the fleet-bin resolver used by upgrade tests: fleet commands are
    // installed below the operator's heddle home, not vendored from a project checkout.
    this.script = join(home, '.heddle', 'fleet', 'bin', 'lin.sh');
  }

  available(): boolean {
    if (!existsSync(this.script)) return false;
    const probe = this.run(['whoami']);
    // A missing credential setup makes the command unavailable to this onboarding step. Other
    // failures (such as a transient network error) still leave the CLI installed, so run() can
    // report their actionable error rather than incorrectly asking for installation.
    return !/credentials?\s+(?:not\s+set\s+up|missing)|missing\s+[—-]\s*Linear\s+agent\s+credentials/i.test(probe.error ?? probe.output);
  }

  async whoami(agent?: string): Promise<{ ok: boolean; identity?: string; error?: string }> {
    const result = this.run(agent ? ['--agent', agent, 'whoami'] : ['whoami']);
    if (!result.ok) return { ok: false, error: result.error ?? 'lin.sh whoami failed' };
    const identity = /^identity\s*:\s*(.+)$/mi.exec(result.output)?.[1]?.trim();
    return { ok: true, identity: identity || undefined };
  }

  async team(teamKey: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    // `list` reads the configured team but does not mutate Linear. A successful empty result is
    // still a reachable team, so retain the requested key as the useful report name.
    const result = this.run(['list'], { LIN_TEAM: teamKey });
    return result.ok
      ? { ok: true, name: teamKey }
      : { ok: false, error: result.error ?? `could not reach Linear team ${teamKey}` };
  }

  private run(args: string[], overrides: NodeJS.ProcessEnv = {}): CommandResult {
    try {
      const output = execFileSync(this.script, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...overrides },
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

const unavailableGuide = [
  'GUIDE: Linear checks need the fleet CLI and an operator-provisioned OAuth app.',
  '1. Install the fleet CLI: heddle fleet install-bin',
  '2. Provision Linear OAuth agent credentials, then run lin.sh whoami to see the exact credentials path it expects.',
].join('\n');

function oauthGuide(agent: string): string {
  return `GUIDE: Agent ${agent} has no Linear OAuth app — in Linear → Settings → API → OAuth applications create an app (scopes read, write, issues:create, comments:create, app:assignable, app:mentionable) and add its client_id/client_secret under agents[${agent}] in the credentials file lin.sh reports (a Linear-workspace-admin step this wizard cannot automate).`;
}

function registryPath(): string {
  return process.env.HEDDLE_PROJECTS?.trim() || DEFAULT_PROJECTS_PATH;
}

function enteredProject(linearTeam: string, agentIds: string[]): Pick<Project, 'linearTeam' | 'agentIds'> {
  return { linearTeam, agentIds };
}

/** A project-scoped, verification-only onboarding step; it never writes files or Linear data. */
export function linearStep(runner: LinearRunner = new LinShLinearRunner()): WizardStep {
  return {
    id: 'linear',
    title: 'Linear onboarding',
    applies: (ctx) => !!ctx.targetDir,
    async run(ctx, io): Promise<WizardStepResult> {
      const skip = (summary: string, detail?: string): WizardStepResult => ({ id: 'linear', status: 'skipped', summary, ...(detail ? { detail } : {}) });
      const fail = (summary: string, detail: string): WizardStepResult => ({ id: 'linear', status: 'failed', summary, detail });

      const proceed = await io.prompter.confirm('Set up / verify Linear for this project now?');
      if (!proceed) return skip('Linear setup skipped — the wizard works without it; re-run heddle setup --only linear anytime.');

      let project: Pick<Project, 'linearTeam' | 'agentIds'>;
      try {
        const registered = projectForCwd(loadProjectRegistry(registryPath()), ctx.targetDir!);
        if (registered) {
          project = registered;
        } else {
          const linearTeam = (await io.prompter.text('Linear team key for this project')).trim();
          const roster = await io.prompter.text('Comma-separated Linear agent roster for this project');
          project = enteredProject(linearTeam, roster.split(',').map((agent) => agent.trim()).filter(Boolean));
        }
      } catch (error) {
        const detail = `GUIDE: Could not resolve this project's Linear registry entry: ${error instanceof Error ? error.message : String(error)}`;
        io.report(detail);
        return fail('Linear project configuration could not be resolved', detail);
      }

      let available: boolean;
      try {
        available = runner.available();
      } catch (error) {
        const detail = `${unavailableGuide}\nGUIDE: lin.sh availability check failed: ${error instanceof Error ? error.message : String(error)}`;
        io.report(detail);
        return skip('Linear tooling is unavailable; setup remains optional', detail);
      }
      if (!available) {
        io.report(unavailableGuide);
        return skip('Linear tooling is unavailable; setup remains optional', unavailableGuide);
      }

      const detail: string[] = [];
      let credentialOk = false;
      try {
        const credential = await runner.whoami();
        if (credential.ok) {
          credentialOk = true;
          io.report(`Linear credential OK: ${credential.identity ?? 'verified identity'}`);
          detail.push(`VERIFIED: credential${credential.identity ? ` (${credential.identity})` : ''}`);
        } else {
          detail.push(`GUIDE: Linear credential check failed${credential.error ? `: ${credential.error}` : ''}. Run lin.sh whoami for the exact credentials path it expects.`);
        }
      } catch (error) {
        detail.push(`GUIDE: Linear credential check failed: ${error instanceof Error ? error.message : String(error)}. Run lin.sh whoami for the exact credentials path it expects.`);
      }

      let teamOk = false;
      try {
        const team = await runner.team(project.linearTeam);
        if (team.ok) {
          teamOk = true;
          detail.push(`VERIFIED: team ${team.name ?? project.linearTeam}`);
        } else {
          detail.push(`GUIDE: Linear team ${project.linearTeam} could not be reached${team.error ? `: ${team.error}` : ''}. Confirm the team key and access, then re-run.`);
        }
      } catch (error) {
        detail.push(`GUIDE: Linear team ${project.linearTeam} could not be reached: ${error instanceof Error ? error.message : String(error)}. Confirm the team key and access, then re-run.`);
      }

      const verifiedAgents: string[] = [];
      const unprovisioned: string[] = [];
      for (const agent of project.agentIds) {
        try {
          const check = await runner.whoami(agent);
          if (check.ok) verifiedAgents.push(agent);
          else { unprovisioned.push(agent); detail.push(oauthGuide(agent)); }
        } catch {
          unprovisioned.push(agent);
          detail.push(oauthGuide(agent));
        }
      }
      if (verifiedAgents.length) detail.push(`VERIFIED: roster ${verifiedAgents.join(', ')}`);

      detail.push('STILL MANUAL: export LIN_TEAM=' + project.linearTeam + ' in your launcher — this wizard does not auto-wire it.');
      const allVerified = credentialOk && teamOk && unprovisioned.length === 0;
      const summary = allVerified
        ? `Linear verified: credential, team ${project.linearTeam}, roster ${project.agentIds.length ? project.agentIds.join(', ') : 'empty'}`
        : `Linear verification incomplete: credential ${credentialOk ? 'verified' : 'needs attention'}; team ${teamOk ? 'verified' : 'needs attention'}; roster ${verifiedAgents.length}/${project.agentIds.length} verified`;
      return allVerified ? { id: 'linear', status: 'done', summary, detail: detail.join('\n') } : fail(summary, detail.join('\n'));
    },
  };
}
