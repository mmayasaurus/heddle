import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepositoryFor } from './worktree.js';
import { clientFileSource } from './client-config.js';

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

export class ClientWorkspaceIdentityConflict extends Error {
  constructor() {
    super('native client identity conflicts with the selected worktree owner');
    this.name = 'ClientWorkspaceIdentityConflict';
  }
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
  if (cwd === fallback) return cwd; // Preserve existing same-workspace launcher identity precedence.
  const bound = env.HEDDLE_AGENT?.trim() || env.FLEET_AGENT?.trim();
  const owner = clientFileSource(join(cwd, '.fleet-agent'))?.trim();
  if (bound && owner && bound !== owner) throw new ClientWorkspaceIdentityConflict();
  return cwd;
}
