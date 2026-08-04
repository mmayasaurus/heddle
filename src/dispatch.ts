import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { Ledger } from './ledger.js';
import { loadRouting, resolveRoute, directRoute, type Route, type RouteTarget } from './routing.js';
import { materializeAgentsMd } from './skillpacks.js';
import { materializeWorkerMcp, codexApprovalFlags } from './mcp.js';
import { classifyEffort } from './classify.js';
import type { WorkerAdapter, WorkerResult } from './types.js';

/**
 * The dispatcher: task class → routed worker → recorded outcome.
 *
 * Every dispatch is written to the ledger (decision AND outcome) so the routing table can be
 * tuned from evidence rather than intuition, and so the dashboard has something to render.
 */

export interface DispatchRequest {
  /** Policy path: a task class from the routing table. Use this OR provider+model. */
  taskClass?: string;
  /** Direct path: name the provider+model yourself (dynamic override). Use with `model`. */
  provider?: string;
  model?: string;
  prompt: string;
  cwd: string;
  /** Fleet identity of the dispatching orchestrator, e.g. "K". */
  orchestrator?: string;
  issue?: string;
  /** Skill packs to materialize; defaults to the routing table's packs for this class. */
  skills?: string[];
  /** Code-discovery MCP servers to attach; defaults to the routing table's mcp for this class. */
  mcp?: string[];
  /** Reasoning effort override (codex/agy); defaults to the routing table's effort for this class. */
  effort?: string;
  /** Opt-in: classify the sub-task's difficulty with a cheap model and pin the effort (if `effort`
   *  isn't already set). Adds one cheap classification dispatch up front. */
  autoEffort?: boolean;
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
  const mcp = req.mcp ?? target.mcp ?? [];
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

  const restoreSkills = materializeAgentsMd(req.cwd, skills);
  const restoreMcp = materializeWorkerMcp(req.cwd, target.provider, mcp);

  // Codex needs its attached MCP servers' tools pre-approved per-invocation, or headless calls
  // cancel. This makes heddle self-contained — it works even if the user's global codex config
  // hasn't pre-approved the server.
  const extraFlags = [
    ...(target.extraFlags ?? []),
    ...(target.provider === 'codex' && mcp.length ? codexApprovalFlags(mcp) : []),
    // Cursor, like codex, blocks headless MCP calls without approval: --approve-mcps clears the
    // server, --force (Run Everything) clears the per-call gate that otherwise rejects tool calls.
    ...(target.provider === 'cursor' && mcp.length ? ['--approve-mcps', '--force'] : []),
  ];

  let result: WorkerResult;
  try {
    result = await adapter.dispatch(req.prompt, {
      model: target.model,
      cwd: req.cwd,
      effort: req.effort ?? target.effort,
      extraFlags,
      timeoutMs: req.timeoutMs,
      resume: req.resume,
      env: req.env,
    });
  } catch (err) {
    result = { ok: false, output: '', exitCode: null, error: String((err as Error).message ?? err) };
  } finally {
    restoreMcp();
    restoreSkills();
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
  const table = loadRouting();

  // Auto-effort (opt-in): classify the sub-task's difficulty and pin the effort, unless the caller
  // already set one. Best-effort — a classifier failure falls through to the route/default effort.
  if (req.autoEffort && !req.effort) {
    const ctx = req.taskClass ?? (req.provider && req.model ? `${req.provider}/${req.model}` : 'general');
    try {
      req = { ...req, effort: await classifyEffort(ctx, req.prompt, req.cwd) };
    } catch { /* fall through */ }
  }

  // Direct path: orchestrator named the model. Full dynamic choice, still policy-fenced.
  if (req.provider && req.model) {
    const route = directRoute(table, req.provider, req.model, req.skills, req.mcp);
    return runTarget(route, req, ledger, route, null);
  }
  if (!req.taskClass) {
    throw new Error('dispatch requires either a task class or an explicit provider+model');
  }

  const route = resolveRoute(table, req.taskClass);
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
