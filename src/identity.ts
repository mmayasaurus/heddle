import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Process-bound identity — WHO is dispatching, decided ONCE from the process environment, never by
 * the model's tool arguments (HED-65: lineage inputs must not be caller-supplied).
 *
 * Resolution order (first hit wins), mirroring the fleet's own `lin.sh` rules:
 *   1. HEDDLE_AGENT env            — explicit heddle binding (a launcher or the dashboard sets it)
 *   2. FLEET_AGENT env             — the fleet identity the Spinventory launchers already export
 *   3. `.fleet-agent` file         — at `cwd` or any parent (a worktree pinned to an identity)
 *   4. unbound                     — a caller-supplied `agent` may then be used, and the ledger
 *                                    records that the identity was NOT process-bound.
 *
 * Worker context: heddle stamps every worker subprocess with HEDDLE_WORKER=1 (+ HEDDLE_DISPATCH_ID,
 * HEDDLE_PARENT). A heddle MCP server or CLI started INSIDE such a process therefore knows it is a
 * worker — that is how the depth-1 cap ("workers cannot dispatch workers") is enforced without any
 * trust in what the model claims about itself.
 */

export type IdentitySource = 'env:HEDDLE_AGENT' | 'env:FLEET_AGENT' | 'file:.fleet-agent' | 'unbound';

export interface WorkerContext {
  /** Ledger id of the dispatch that spawned this process, when stamped. */
  dispatchId: number | null;
  /** Identity of the orchestrator that spawned this process, when it was bound. */
  parent: string | null;
}

export interface BoundIdentity {
  /** The bound fleet identity (e.g. "U"), or null when unbound. */
  agent: string | null;
  source: IdentitySource;
  /** Non-null iff this process runs inside a heddle-spawned worker (HEDDLE_WORKER=1). */
  worker: WorkerContext | null;
}

/** Env var names heddle stamps on every worker subprocess (see dispatch.ts). */
export const WORKER_ENV = {
  WORKER: 'HEDDLE_WORKER',
  DISPATCH_ID: 'HEDDLE_DISPATCH_ID',
  PARENT: 'HEDDLE_PARENT',
} as const;

function findFleetAgentFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, '.fleet-agent');
    if (existsSync(f)) {
      try {
        const v = readFileSync(f, 'utf8').trim();
        if (v) return v;
      } catch { /* unreadable — keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveIdentity(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): BoundIdentity {
  const worker: WorkerContext | null = env[WORKER_ENV.WORKER] === '1'
    ? {
        dispatchId: env[WORKER_ENV.DISPATCH_ID] && /^\d+$/.test(env[WORKER_ENV.DISPATCH_ID]!)
          ? Number(env[WORKER_ENV.DISPATCH_ID]) : null,
        parent: env[WORKER_ENV.PARENT]?.trim() || null,
      }
    : null;

  const fromEnv = (k: string) => (env[k] ?? '').trim();
  if (fromEnv('HEDDLE_AGENT')) return { agent: fromEnv('HEDDLE_AGENT'), source: 'env:HEDDLE_AGENT', worker };
  if (fromEnv('FLEET_AGENT')) return { agent: fromEnv('FLEET_AGENT'), source: 'env:FLEET_AGENT', worker };
  const fileAgent = findFleetAgentFile(cwd);
  if (fileAgent) return { agent: fileAgent, source: 'file:.fleet-agent', worker };
  return { agent: null, source: 'unbound', worker };
}

/**
 * The orchestrator identity a dispatch is attributed to: the process-bound identity when there is
 * one (the caller's `agent` argument is then ignored — the model does not get to choose who it is);
 * otherwise the caller-supplied value, marked as such.
 */
export function attributeDispatch(bound: BoundIdentity, callerAgent?: string | null): {
  orchestrator: string | null;
  /** `worker-parent` is set by the dispatcher for a refused nested dispatch (attributed to the spawner). */
  identitySource: 'bound' | 'caller' | 'worker-parent' | null;
  /** Set when a caller-supplied agent disagreed with the bound identity (bound wins). */
  ignoredCallerAgent?: string;
} {
  const caller = callerAgent?.trim() || null;
  if (bound.agent) {
    return caller && caller !== bound.agent
      ? { orchestrator: bound.agent, identitySource: 'bound', ignoredCallerAgent: caller }
      : { orchestrator: bound.agent, identitySource: 'bound' };
  }
  return caller ? { orchestrator: caller, identitySource: 'caller' } : { orchestrator: null, identitySource: null };
}
