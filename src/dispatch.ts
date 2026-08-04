import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { Ledger } from './ledger.js';
import { loadRouting, resolveRoute, type Route, type RouteTarget } from './routing.js';
import { materializeAgentsMd } from './skillpacks.js';
import type { WorkerAdapter, WorkerResult } from './types.js';

/**
 * The dispatcher: task class → routed worker → recorded outcome.
 *
 * Every dispatch is written to the ledger (decision AND outcome) so the routing table can be
 * tuned from evidence rather than intuition, and so the dashboard has something to render.
 */

export interface DispatchRequest {
  taskClass: string;
  prompt: string;
  cwd: string;
  /** Fleet identity of the dispatching orchestrator, e.g. "K". */
  orchestrator?: string;
  issue?: string;
  /** Skill packs to materialize; defaults to the routing table's packs for this class. */
  skills?: string[];
  timeoutMs?: number;
  resume?: string;
  /** Per-dispatch account selection (CODEX_HOME, CURSOR_API_KEY, …). See src/env.ts. */
  env?: Record<string, string>;
  /** Required to run a task class marked requires_explicit_opt_in. */
  optIn?: boolean;
  /** Skip the routing table's fallback on failure. */
  noFallback?: boolean;
}

export interface DispatchOutcome extends WorkerResult {
  taskClass: string;
  provider: string;
  model: string;
  skills: string[];
  ledgerId: number;
  usedFallback: boolean;
}

function adapterFor(provider: string): WorkerAdapter {
  switch (provider) {
    case 'codex': return new CodexAdapter();
    case 'cursor': return new CursorAdapter();
    case 'gemini': return new AgyAdapter();
    case 'claude':
      throw new Error(
        'claude workers are in-session subagents of the orchestrator, not spawned subprocesses — ' +
        'use your own Agent tool with the routed model instead of `heddle dispatch` ' +
        '(see src/adapters/claude.ts for why)',
      );
    default:
      throw new Error(`no adapter for provider "${provider}"`);
  }
}

async function runTarget(
  target: RouteTarget, req: DispatchRequest, ledger: Ledger, route: Route,
  fellBackFrom: string | null,
): Promise<DispatchOutcome> {
  const skills = req.skills ?? target.skills ?? [];
  const adapter = adapterFor(target.provider);

  const ledgerId = ledger.start({
    orchestrator: req.orchestrator ?? null,
    taskClass: route.taskClass,
    provider: target.provider,
    model: target.model,
    skills: skills.length ? skills.join(',') : null,
    issue: req.issue ?? null,
    pr: null,
    cwd: req.cwd,
    promptPreview: req.prompt,
    sessionId: req.resume ?? null,
    fellBackFrom,
  });

  const restore = materializeAgentsMd(req.cwd, skills);
  let result: WorkerResult;
  try {
    result = await adapter.dispatch(req.prompt, {
      model: target.model,
      cwd: req.cwd,
      extraFlags: target.extraFlags,
      timeoutMs: req.timeoutMs,
      resume: req.resume,
      env: req.env,
    });
  } catch (err) {
    result = { ok: false, output: '', exitCode: null, error: String((err as Error).message ?? err) };
  } finally {
    restore();
  }

  ledger.finish(ledgerId, {
    ok: result.ok,
    error: result.error,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    inputTokens: result.usage?.inputTokens,
    cachedInputTokens: result.usage?.cachedInputTokens,
    outputTokens: result.usage?.outputTokens,
    reasoningTokens: result.usage?.reasoningOutputTokens,
  });

  return {
    ...result,
    taskClass: route.taskClass,
    provider: target.provider,
    model: target.model,
    skills,
    ledgerId,
    usedFallback: fellBackFrom !== null,
  };
}

export async function dispatch(req: DispatchRequest, ledger = new Ledger()): Promise<DispatchOutcome> {
  const route = resolveRoute(loadRouting(), req.taskClass);

  if (route.requiresExplicitOptIn && !req.optIn) {
    throw new Error(
      `task class "${req.taskClass}" requires explicit opt-in` +
      (route.note ? ` — ${route.note}` : '') + '. Pass optIn/--opt-in to proceed.',
    );
  }

  const primary = await runTarget(route, req, ledger, route, null);
  if (primary.ok || req.noFallback || !route.fallback) return primary;

  // Primary failed and the table names a fallback — try it, recording the origin so the ledger
  // shows which routes actually hold up in practice.
  return runTarget(route.fallback, req, ledger, route, `${route.provider}/${route.model}`);
}
