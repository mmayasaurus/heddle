import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepositoryFor } from './worktree.js';
import { clientFileSource } from './client-config.js';
import { parseAddress } from './comms/address.js';

/** A copied native config may follow a linked checkout, never an unrelated clone or subdirectory. */
export function sameClientWorkspace(configured: string, candidate: string): boolean {
  try {
    const from = realpathSync(configured), to = realpathSync(candidate);
    if (from === to) return true;
    const source = gitRepositoryFor(from), target = gitRepositoryFor(to);
    return Boolean(source?.mainRoot && target?.mainRoot
      && realpathSync(source.topLevel) === from && realpathSync(target.topLevel) === to
      && realpathSync(source.mainRoot) === realpathSync(target.mainRoot));
  } catch { return false; } // Missing/unreadable Git identity cannot authorize a different workspace.
}

export class ClientWorkspaceIdentityError extends Error {
  constructor(message: string) { super(message); this.name = 'ClientWorkspaceIdentityError'; }
}

export class ClientWorkspaceIdentityConflict extends ClientWorkspaceIdentityError {
  constructor() {
    super('native client identity conflicts with the selected worktree owner');
    this.name = 'ClientWorkspaceIdentityConflict';
  }
}

function clientAgentAddress(value: string | null | undefined): string | undefined {
  const address = value?.trim(), kind = address ? parseAddress(address)?.kind : null;
  return kind === 'agent' || kind === 'child' ? address : undefined;
}

/** Runtime-only binding keeps tracked native config and its permissions unchanged in worktrees. */
export function resolveClientWorkspace(configured: string, candidates: unknown[], env: NodeJS.ProcessEnv = process.env,
  workerHookCwd?: string): string {
  const fallback = realpathSync(configured);
  if (env.HEDDLE_WORKER === '1') {
    // MCP arguments are materialized by dispatch; copied hooks instead use their actual process cwd.
    // Never let hook payload candidates redirect a worker or compare its child identity to the owner.
    return workerHookCwd && sameClientWorkspace(fallback, workerHookCwd) ? realpathSync(workerHookCwd) : fallback;
  }
  const candidate = candidates.find((value): value is string => typeof value === 'string' && sameClientWorkspace(fallback, value));
  const cwd = candidate ? realpathSync(candidate) : fallback;
  if (cwd === fallback) {
    const repository = gitRepositoryFor(cwd);
    if (!repository) return cwd; // Standalone installs retain explicit launcher identity precedence.
    try {
      if (repository.mainRoot && realpathSync(repository.mainRoot) === cwd) return cwd; // Shared project root.
    } catch { throw new ClientWorkspaceIdentityError('native client checkout identity could not be verified'); }
    if (!repository.mainRoot) throw new ClientWorkspaceIdentityError('native client checkout identity could not be verified');
  }
  const bound = [env.HEDDLE_AGENT, env.FLEET_AGENT, env.HEDDLE_COMMS_ADDRESS].map(clientAgentAddress).find(Boolean);
  let owner: string | undefined;
  try { owner = clientAgentAddress(clientFileSource(join(cwd, '.fleet-agent'), 256)); }
  catch { throw new ClientWorkspaceIdentityError('native client worktree owner could not be verified'); }
  if (bound && owner && bound !== owner) throw new ClientWorkspaceIdentityConflict();
  return cwd;
}
