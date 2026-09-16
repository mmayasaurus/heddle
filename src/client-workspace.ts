import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitRepositoryFor } from './worktree.js';
import { clientFileSource } from './client-config.js';
import { parseAddress } from './comms/address.js';

/** A copied native config may follow a linked checkout, never an unrelated clone or subdirectory. */
export function sameClientWorkspace(configured: string, candidate: string): boolean {
  try {
    const from = realpathSync.native(configured), to = realpathSync.native(candidate);
    if (from === to) return true;
    const source = gitRepositoryFor(from), target = gitRepositoryFor(to);
    return Boolean(source?.mainRoot && target?.mainRoot
      && realpathSync.native(source.topLevel) === from && realpathSync.native(target.topLevel) === to
      && realpathSync.native(source.mainRoot) === realpathSync.native(target.mainRoot));
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

/** Runtime cwd may be below a checkout root; config ownership above deliberately stays exact. */
function sameRuntimeWorkspace(configured: string, candidate: string): boolean {
  try {
    const from = realpathSync.native(configured), to = realpathSync.native(candidate);
    if (from === to) return true;
    const source = gitRepositoryFor(from), target = gitRepositoryFor(to);
    return Boolean(source?.mainRoot && target?.mainRoot
      && realpathSync.native(source.mainRoot) === realpathSync.native(target.mainRoot));
  } catch { return false; }
}

/** Nearest-first policy/owner lookup, bounded by the actual Git checkout (including nested repos). */
export function clientWorkspaceDirectories(cwd: string): string[] {
  const current = realpathSync.native(cwd), repository = gitRepositoryFor(current);
  const root = repository ? realpathSync.native(repository.topLevel) : current;
  const directories: string[] = [];
  for (let dir = current; ; dir = dirname(dir)) {
    directories.push(dir);
    if (dir === root) return directories;
    if (dirname(dir) === dir) throw new ClientWorkspaceIdentityError('native client checkout identity could not be verified');
  }
}

/** Runtime-only binding keeps tracked native config and its permissions unchanged in worktrees. */
export function resolveClientWorkspace(configured: string, candidates: unknown[], env: NodeJS.ProcessEnv = process.env,
  workerHookCwd?: string): string {
  const fallback = realpathSync.native(configured);
  if (env.HEDDLE_WORKER === '1') {
    // MCP arguments are materialized by dispatch; copied hooks instead use their actual process cwd.
    // Never let hook payload candidates redirect a worker or compare its child identity to the owner.
    return workerHookCwd && sameRuntimeWorkspace(fallback, workerHookCwd) ? realpathSync.native(workerHookCwd) : fallback;
  }
  const candidate = candidates.find((value): value is string => typeof value === 'string' && sameRuntimeWorkspace(fallback, value));
  const cwd = candidate ? realpathSync.native(candidate) : fallback;
  const repository = gitRepositoryFor(cwd);
  if (!repository) return cwd; // Standalone installs retain explicit launcher identity precedence.
  try {
    if (repository.mainRoot && realpathSync.native(repository.mainRoot) === realpathSync.native(repository.topLevel)) return cwd;
  } catch { throw new ClientWorkspaceIdentityError('native client checkout identity could not be verified'); }
  if (!repository.mainRoot) throw new ClientWorkspaceIdentityError('native client checkout identity could not be verified');
  const bound = [env.HEDDLE_AGENT, env.FLEET_AGENT, env.HEDDLE_COMMS_ADDRESS].map(clientAgentAddress).find(Boolean);
  let owner: string | undefined;
  try {
    for (const dir of clientWorkspaceDirectories(cwd)) {
      owner = clientAgentAddress(clientFileSource(join(dir, '.fleet-agent'), 256));
      if (owner) break;
    }
  }
  catch { throw new ClientWorkspaceIdentityError('native client worktree owner could not be verified'); }
  if (bound && owner && bound !== owner) throw new ClientWorkspaceIdentityConflict();
  return cwd;
}
