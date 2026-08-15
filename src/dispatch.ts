import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { Ledger } from './ledger.js';
import {
  loadRouting, resolveRoute, directRoute, providerExecution, type Route, type RouteTarget, type RoutingTable,
} from './routing.js';
import { materializeAgentsMd, withMandatoryPacks } from './skillpacks.js';
import { materializeWorkerMcp, codexMcpFlags } from './mcp.js';
import { classifyEffort } from './classify.js';
import type { WorkerAdapter, WorkerResult } from './types.js';

/**
 * The dispatcher: task class → routed worker → recorded outcome.
 *
 * Every dispatch is written to the ledger (decision AND outcome) so the routing table can be
 * tuned from evidence rather than intuition, and so the dashboard has something to render.
 */

export interface DispatchRequest {
  /**
   * Policy path: a task class from the routing table (route + default skills/mcp + opt-in gate +
   * edits_code). May be COMBINED with provider+model: the class then supplies the policy and the
   * named provider/model replaces its route (no fallback) — e.g. an adversarial reviewer that must
   * run on a different provider than the author, but under the review class's rules.
   */
  taskClass?: string;
  /** Direct path: name the provider+model yourself (dynamic override, still policy-fenced). */
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

/**
 * heddle declined to run the dispatch itself — no worker was spawned. Structured so an orchestrator
 * (or its hook) can act on the code instead of parsing prose; the same code is in the ledger's
 * `refusal` column.
 */
export interface DispatchRefusal {
  /** `claude-in-session` today; structural caps (HED-2) add `depth-1`, `max-children`, `capability-denied`. */
  code: string;
  reason: string;
  /** What to do instead, when there is a clear alternative. */
  instruction?: string;
}

export interface DispatchOutcome extends WorkerResult {
  taskClass: string;
  provider: string;
  model: string;
  skills: string[];
  ledgerId: number;
  usedFallback: boolean;
  /** How the provider runs workers (`in-session-subagent` = the orchestrator's own Agent tool). */
  execution?: string;
  /** Present iff heddle refused to run the dispatch (ok is then false). */
  refusal?: DispatchRefusal;
}

/** Resolves a provider name to its adapter. Injectable into dispatch() so tests can run the full
 *  dispatch pipeline (routing → skills/MCP materialization → ledger) against a fake worker. */
export type AdapterFactory = (provider: string) => WorkerAdapter;

export function defaultAdapterFor(provider: string): WorkerAdapter {
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
  fellBackFrom: string | null, adapterFor: AdapterFactory, table: RoutingTable,
): Promise<DispatchOutcome> {
  // Caller's explicit list REPLACES the table default; the mandatory governance pack(s) are unioned
  // into whichever applies (see skillpacks.ts) — the ledger records the result, so it is auditable.
  const skills = withMandatoryPacks(req.skills ?? target.skills ?? []);
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
    ...(target.provider === 'codex' && mcp.length ? codexMcpFlags(mcp) : []),
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
    execution: providerExecution(table, target.provider),
  };
}

export async function dispatch(
  req: DispatchRequest, ledger = new Ledger(), adapterFor: AdapterFactory = defaultAdapterFor,
): Promise<DispatchOutcome> {
  const table = loadRouting();

  // Auto-effort (opt-in): classify the sub-task's difficulty and pin the effort, unless the caller
  // already set one. Best-effort — a classifier failure falls through to the route/default effort.
  if (req.autoEffort && !req.effort) {
    const ctx = req.taskClass ?? (req.provider && req.model ? `${req.provider}/${req.model}` : 'general');
    try {
      req = { ...req, effort: await classifyEffort(ctx, req.prompt, req.cwd) };
    } catch { /* fall through */ }
  }

  // A route override is provider AND model, or neither — a lone half would silently run the class's
  // default route (or the wrong one), so it is rejected outright.
  if (Boolean(req.provider) !== Boolean(req.model)) {
    throw new Error(
      `dispatch: provider and model must be given together (got provider=${JSON.stringify(req.provider ?? null)}, ` +
      `model=${JSON.stringify(req.model ?? null)})`,
    );
  }

  // Direct path, no class: orchestrator named the model. Full dynamic choice, still policy-fenced.
  if (!req.taskClass) {
    if (req.provider && req.model) {
      const route = directRoute(table, req.provider, req.model, req.skills, req.mcp);
      const execution = providerExecution(table, route.provider);
      if (execution === 'in-session-subagent') return refuseInSession(route, req, ledger, execution, 'direct');
      return runTarget(route, req, ledger, route, null, adapterFor, table);
    }
    throw new Error('dispatch requires either a task class or an explicit provider+model');
  }

  const route = resolveRoute(table, req.taskClass);
  if (route.requiresExplicitOptIn && !req.optIn) {
    throw new Error(
      `task class "${req.taskClass}" requires explicit opt-in` +
      (route.note ? ` — ${route.note}` : '') + '. Pass optIn/--opt-in to proceed.',
    );
  }
  // A non-dispatchable class (`orchestration`) is refused on EVERY path — a named subprocess route
  // does not turn the orchestrator's own work into a worker task.
  if (!route.dispatchable) {
    // Report the route the caller actually named (if any) so the structured fields, the ledger row
    // and the reason agree; the class stays the ledger's task_class.
    const named = req.provider && req.model
      ? { ...route, ...directRoute(table, req.provider, req.model, req.skills ?? route.skills, req.mcp ?? route.mcp), taskClass: route.taskClass }
      : route;
    return refuseNotDispatchable(named, req, ledger, table);
  }

  // Class + explicit provider/model: the class supplies policy (default skills/mcp, opt-in gate,
  // ledger task_class), the named route replaces the table's — no fallback, naming it is the choice.
  if (req.provider && req.model) {
    const explicit = directRoute(table, req.provider, req.model, req.skills ?? route.skills, req.mcp ?? route.mcp);
    const execution = providerExecution(table, explicit.provider);
    if (execution === 'in-session-subagent') {
      // Keep the class's declared fallback so the instruction can still name a subprocess route.
      return refuseInSession(
        { ...route, provider: explicit.provider, model: explicit.model, skills: explicit.skills, mcp: explicit.mcp },
        req, ledger, execution, 'explicit',
      );
    }
    // Effort is deliberately NOT inherited from the class (per-provider vocabulary) — pass it explicitly.
    const target: RouteTarget = { ...explicit, effort: req.effort };
    return runTarget(target, req, ledger, route, null, adapterFor, table);
  }

  // Claude-primary classes run as the orchestrator's OWN in-session subagents (shared prompt cache,
  // flat pool — src/adapters/claude.ts), so a subprocess dispatcher cannot run them. Return a
  // structured, ledgered refusal instead of throwing (decided 2026-08-15, HED-18): the orchestrator
  // uses its Agent tool with the routed model, or names provider+model to run the class elsewhere.
  const execution = providerExecution(table, route.provider);
  if (execution === 'in-session-subagent') return refuseInSession(route, req, ledger, execution, 'class');

  const primary = await runTarget(route, req, ledger, route, null, adapterFor, table);
  if (primary.ok || req.noFallback || !route.fallback) return primary;

  // Primary failed and the table names a fallback — try it, recording the origin so the ledger
  // shows which routes actually hold up in practice. A fallback that is itself in-session (custom
  // tables) gets the same structured refusal instead of a throw.
  const fbExecution = providerExecution(table, route.fallback.provider);
  if (fbExecution === 'in-session-subagent') {
    return refuseInSession(
      { ...route, provider: route.fallback.provider, model: route.fallback.model,
        skills: route.fallback.skills, mcp: route.fallback.mcp, fallback: undefined },
      req, ledger, fbExecution, 'fallback', `${route.provider}/${route.model}`,
    );
  }
  return runTarget(route.fallback, req, ledger, route, `${route.provider}/${route.model}`, adapterFor, table);
}

/** How the in-session route was chosen — the refusal reason must not misstate the YAML policy. */
type InSessionOrigin = 'direct' | 'class' | 'explicit' | 'fallback';

function refuseNotDispatchable(route: Route, req: DispatchRequest, ledger: Ledger, table: RoutingTable): DispatchOutcome {
  const skills = req.skills ?? route.skills ?? [];
  const reason = `task class "${route.taskClass}" is not dispatchable (dispatchable: false) — it is the ` +
    `orchestrator's own in-session work` + (req.provider && req.model ? `; naming a route (${req.provider}/${req.model}) does not change that` : '') + '.';
  const instruction = `Continue yourself; there is nothing to delegate.`;
  const ledgerId = ledger.refuse({
    orchestrator: req.orchestrator ?? null, taskClass: route.taskClass, provider: route.provider,
    model: route.model, skills: skills.length ? skills.join(',') : null, issue: req.issue ?? null, pr: null,
    cwd: req.cwd, promptPreview: req.prompt, sessionId: null, fellBackFrom: null,
  }, 'not-dispatchable', reason);
  return {
    ok: false, output: '', exitCode: null, error: `${reason} ${instruction}`,
    taskClass: route.taskClass, provider: route.provider, model: route.model, skills, ledgerId,
    usedFallback: false, execution: providerExecution(table, route.provider),
    refusal: { code: 'not-dispatchable', reason, instruction },
  };
}

function refuseInSession(
  route: Route, req: DispatchRequest, ledger: Ledger, execution: string, origin: InSessionOrigin,
  fellBackFrom: string | null = null,
): DispatchOutcome {
  // (Non-dispatchable classes never reach here — refuseNotDispatchable handles them earlier.)
  const skills = withMandatoryPacks(req.skills ?? route.skills ?? []);
  const mcp = req.mcp ?? route.mcp ?? []; // the caller's override wins, exactly as it would on a run
  const alt = route.fallback ? ` To run it as a subprocess instead, name provider+model explicitly ` +
    `(e.g. provider="${route.fallback.provider}", model="${route.fallback.model}" — the class's ` +
    `declared fallback) with the same task_class.` : '';
  const head = {
    direct: `direct route ${route.provider}/${route.model} names a provider that`,
    class: `task class "${route.taskClass}" routes to ${route.provider}/${route.model}, which`,
    explicit: `task class "${route.taskClass}" was given the explicit route ${route.provider}/${route.model}, which`,
    fallback: `task class "${route.taskClass}" fell back to ${route.provider}/${route.model} (its declared fallback), which`,
  }[origin];
  const reason = `${head} runs as an in-session subagent of the orchestrator, not a subprocess heddle can spawn.`;
  const instruction =
    `Use your own Agent tool with model "${route.model}" and skills [${skills.join(', ')}]` +
    (mcp.length ? ` and MCP [${mcp.join(', ')}]` : '') + `.` + alt;
  const ledgerId = ledger.refuse({
    orchestrator: req.orchestrator ?? null, taskClass: route.taskClass, provider: route.provider,
    model: route.model, skills: skills.length ? skills.join(',') : null, issue: req.issue ?? null, pr: null,
    cwd: req.cwd, promptPreview: req.prompt, sessionId: null, fellBackFrom,
  }, 'claude-in-session', reason);
  return {
    ok: false, output: '', exitCode: null, error: `${reason} ${instruction}`,
    taskClass: route.taskClass, provider: route.provider, model: route.model, skills, ledgerId,
    usedFallback: fellBackFrom !== null, execution,
    refusal: { code: 'claude-in-session', reason, instruction },
  };
}
