import spawn from 'cross-spawn';
import { realpathSync } from 'node:fs';
import { resolveIdentity } from './identity.js';
import { parseAddress } from './comms/address.js';
import { killGroupOrChild } from './adapters/subprocess.js';
import { applyInstall } from './init-project.js';
import { codexClientFlags, planClientInstall, type FleetClient } from './client-config.js';

export interface ClientSessionOptions {
  client: FleetClient; dir: string; agent?: string; model?: string; resume?: string;
  bin?: string; args?: string[]; dryRun?: boolean;
}

export function planClientSession(options: ClientSessionOptions, env: NodeJS.ProcessEnv = process.env) {
  const dir = realpathSync.native(options.dir);
  const identity = resolveIdentity(dir, env);
  if (identity.worker) throw new Error('a Heddle worker cannot launch a fleet orchestrator session');
  const agent = options.agent ?? identity.agent;
  if (!agent || parseAddress(agent)?.kind !== 'agent') throw new Error('launch requires an assigned fleet identity via --agent, environment, or .fleet-agent');
  const fileIdentity = resolveIdentity(dir, {});
  if (fileIdentity.agent && fileIdentity.agent !== agent) throw new Error(`worktree belongs to ${fileIdentity.agent}; refusing to launch ${agent} there`);
  const args: string[] = [];
  if (options.client === 'codex') {
    args.push(...codexClientFlags(dir, agent));
    if (options.resume) args.push('resume', options.resume === 'latest' ? '--last' : options.resume);
    args.push('--cd', dir);
  } else if (options.client === 'cursor') {
    args.push('--workspace', dir);
    if (options.resume) args.push(...(options.resume === 'latest' ? ['--continue'] : ['--resume', options.resume]));
  } else if (options.client === 'gemini') {
    if (options.resume) args.push('--resume', options.resume);
  } else {
    if (options.resume) args.push(...(options.resume === 'latest' ? ['--continue'] : ['--session', options.resume]));
  }
  if (options.model) args.push('--model', options.model);
  args.push(...(options.args ?? []));
  const bin = options.bin ?? { codex: 'codex', cursor: 'cursor-agent', gemini: 'gemini', opencode: 'opencode' }[options.client];
  return { client: options.client, bin, args, dir, agent };
}

/** Launch the real native TUI with its own approval/auth/resume controls and Heddle's binding. */
export async function runClientSession(options: ClientSessionOptions): Promise<number> {
  const plan = planClientSession(options);
  const install = planClientInstall({ dir: plan.dir, clients: [plan.client], agent: plan.agent, dryRun: options.dryRun });
  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ ...plan, steps: install.steps.map(({ step, path, action }) => ({ step, path, action })) }, null, 2) + '\n');
    return 0;
  }
  applyInstall(install);
  // An interactive native launch keeps the operator's chosen native login/configuration.
  // Worker dispatch uses its separate credential-isolating environment builder.
  const env = { ...process.env };
  for (const key of ['HEDDLE_WORKER', 'HEDDLE_COMMS_ADDRESS', 'HEDDLE_PARENT', 'HEDDLE_DISPATCH_ID', 'HEDDLE_COMMS_ROLE', 'HEDDLE_COMMS_OPERATOR_TOKEN']) delete env[key];
  Object.assign(env, { HEDDLE_AGENT: plan.agent, FLEET_AGENT: plan.agent,
    HEDDLE_CLIENT: plan.client, HEDDLE_COMMS_TRANSPORT: 'stdio', HEDDLE_COMMS_PUSH: '0' });
  process.stderr.write(`heddle: ${plan.agent} → ${plan.client} in ${plan.dir}. Review new native hooks/MCP servers in the client's trust controls.\n`);
  return new Promise<number>((resolve) => {
    const child = spawn(plan.bin, plan.args, { cwd: plan.dir, env, stdio: 'inherit' });
    let interrupted = false;
    const forward = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') {
          if (signal === 'SIGINT') interrupted = true;
          killGroupOrChild(child);
        }
        else child.kill(signal);
      } catch { /* already exited */ }
    };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM'), hangup = () => forward('SIGHUP');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.on('SIGHUP', hangup);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup); };
    child.once('error', (error) => { cleanup(); process.stderr.write(`heddle: could not launch ${plan.client}: ${error.message}\n`); resolve(1); });
    child.once('close', (code, signal) => { cleanup(); resolve(interrupted ? 130 : code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}
