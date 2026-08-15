import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { Ledger, type DispatchStartRecord } from './ledger.js';
import {
  loadRouting, resolveRoute, directRoute, providerExecution, structuralCaps,
  type Route, type RouteTarget, type RoutingTable, type StructuralCaps,
} from './routing.js';
import { materializeAgentsMd, readPack, withMandatoryPacks } from './skillpacks.js';
import { materializeWorkerMcp, validateWorkerMcp, codexMcpFlags } from './mcp.js';
import { classifyEffort } from './classify.js';
import { decideCapabilities } from './capabilities.js';
import { resolveIdentity, attributeDispatch, WORKER_ENV, type BoundIdentity } from './identity.js';
import type { WorkerAdapter, WorkerResult } from './types.js';

/**
 * The dispatcher: task class → routed worker → recorded outcome.
 *
 * Every dispatch is written to the ledger (decision AND outcome) so the routing table can be
 * tuned from evidence rather than intuition, and so the dashboard has something to render.
 *
 * Structural caps (HED-2, Scape-derived, clean-room) are enforced HERE, not in prompts:
 *   depth-1        a heddle worker (HEDDLE_WORKER=1 in its env) cannot dispatch workers;
 *   max-children   one orchestrator may have at most N workers in flight (policy, default 8),
 *                  checked in the same transaction that opens the ledger row;
 *   capabilities   default-deny; grants are an allowlist, ledgered, and passed only to a CLI that
 *                  can enforce them (src/capabilities.ts).
 * Every refusal is a finished ledger row (`refusal` column) — never a silent no-op, never in flight.
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
  /**
   * Fleet identity of the dispatching orchestrator, e.g. "K" — used ONLY when the process has no
   * bound identity (src/identity.ts); a bound identity always wins and the ledger records which.
   */
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
  /** Required to run a task class marked requires_explicit_opt_in, and to grant `exec-privileged`. */
  optIn?: boolean;
  /** Skip the routing table's fallback on failure. */
  noFallback?: boolean;
  /** Capabilities to GRANT the worker (allowlist: net, browse, exec-privileged). Default: none. */
  capabilities?: string[];
  /** Process-bound identity; resolved from the environment when omitted (tests inject one). */
  identity?: BoundIdentity;
}

/**
 * heddle declined to run the dispatch itself — no worker was spawned. Structured so an orchestrator
 * (or its hook) can act on the code instead of parsing prose; the same code is in the ledger's
 * `refusal` column.
 */
export interface DispatchRefusal {
  code: 'claude-in-session' | 'depth-1' | 'max-children' | 'capability-denied';
  reason: string;
  /** What to do instead, when there is a clear alternative. */
  instruction?: string;
}

export interface DispatchOutcome extends WorkerResult {
  taskClass: string;
  provider: string;
  model: string;
  skills: string[];
  /** Capabilities actually granted (empty = default-deny only). */
  capabilities: string[];
  ledgerId: number;
  usedFallback: boolean;
  /** Who this dispatch is attributed to in the ledger, and how that was decided. */
  orchestrator: string | null;
  identitySource: 'bound' | 'caller' | null;
  /** Set when a caller-supplied `agent` disagreed with the process-bound identity (bound won). */
  ignoredCallerAgent?: string;
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

/** Everything a dispatch decided before any worker ran — shared by the run and refusal paths. */
interface DispatchContext {
  table: RoutingTable;
  ledger: Ledger;
  adapterFor: AdapterFactory;
  identity: BoundIdentity;
  attribution: ReturnType<typeof attributeDispatch>;
  caps: StructuralCaps;
}

function baseRecord(
  ctx: DispatchContext, req: DispatchRequest, taskClass: string, target: RouteTarget,
  skills: string[], fellBackFrom: string | null, capabilities: string[] = [],
): DispatchStartRecord {
  return {
    orchestrator: ctx.attribution.orchestrator,
    identitySource: ctx.attribution.identitySource,
    taskClass,
    provider: target.provider,
    model: target.model,
    skills: skills.length ? skills.join(',') : null,
    capabilities: capabilities.length ? capabilities.join(',') : null,
    issue: req.issue ?? null,
    pr: null,
    cwd: req.cwd,
    promptPreview: req.prompt,
    sessionId: req.resume ?? null,
    fellBackFrom,
  };
}

function refusalOutcome(
  ctx: DispatchContext, req: DispatchRequest, taskClass: string, target: RouteTarget,
  skills: string[], refusal: DispatchRefusal, extra: Partial<DispatchOutcome> = {},
  ledgerId?: number,
): DispatchOutcome {
  const id = ledgerId ?? ctx.ledger.refuse(
    baseRecord(ctx, req, taskClass, target, skills, null), refusal.code, refusal.reason,
  );
  return {
    ok: false, output: '', exitCode: null,
    error: refusal.instruction ? `${refusal.reason} ${refusal.instruction}` : refusal.reason,
    taskClass, provider: target.provider, model: target.model, skills, capabilities: [],
    ledgerId: id, usedFallback: false,
    orchestrator: ctx.attribution.orchestrator, identitySource: ctx.attribution.identitySource,
    ...(ctx.attribution.ignoredCallerAgent ? { ignoredCallerAgent: ctx.attribution.ignoredCallerAgent } : {}),
    refusal, ...extra,
  };
}

async function runTarget(
  target: RouteTarget, req: DispatchRequest, ctx: DispatchContext, route: Route,
  fellBackFrom: string | null,
): Promise<DispatchOutcome> {
  // Caller's explicit list REPLACES the table default; the mandatory governance pack(s) are unioned
  // into whichever applies (see skillpacks.ts) — the ledger records the result, so it is auditable.
  const skills = withMandatoryPacks(req.skills ?? target.skills ?? []);
  const mcp = req.mcp ?? target.mcp ?? [];

  // Capabilities are decided per TARGET provider (a fallback may enforce a different set).
  const caps = decideCapabilities(target.provider, req.capabilities, req.optIn === true);
  if (caps.refusal) {
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: caps.refusal.code, reason: caps.refusal.reason,
      instruction: 'Drop the capability, or dispatch to a provider that can enforce it (see docs/MODELS.md "Capabilities").',
    }, { usedFallback: fellBackFrom !== null });
  }

  // HED-19: fail fast, BEFORE a ledger row exists, on anything materialization would reject —
  // an unknown pack, an unknown/unsupported MCP attachment, an unknown provider. Nothing is
  // written and nothing is left in flight.
  for (const p of skills) readPack(p);
  validateWorkerMcp(target.provider, mcp);
  const adapter = ctx.adapterFor(target.provider);

  // max-children: count + insert in one transaction (see Ledger.startUnderCap).
  const started = ctx.ledger.startUnderCap(
    baseRecord(ctx, req, route.taskClass, target, skills, fellBackFrom, caps.granted), ctx.caps,
  );
  if (started.refused) {
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: 'max-children', reason: started.reason,
      instruction: 'Wait for a worker to finish (check_workers), or close orphaned rows.',
    }, { usedFallback: fellBackFrom !== null }, started.id);
  }
  const ledgerId = started.id;

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

  // Worker stamps: how a subprocess (and any heddle server/CLI started inside it) knows it is a
  // worker, which dispatch it is, and who its parent is — the basis of the depth-1 cap and of
  // comms lineage (HED-65). Merged over the caller's account-selection env; buildWorkerEnv() still
  // strips billing switches.
  const stamps: Record<string, string> = {
    [WORKER_ENV.WORKER]: '1',
    [WORKER_ENV.DISPATCH_ID]: String(ledgerId),
  };
  if (ctx.attribution.orchestrator) stamps[WORKER_ENV.PARENT] = ctx.attribution.orchestrator;

  // Materialize → run → restore, all inside one guarded region (HED-19): whatever was written is
  // restored even if a later step throws, and the ledger row is ALWAYS finished.
  let restoreSkills: () => void = () => {};
  let restoreMcp: () => void = () => {};
  let result: WorkerResult;
  try {
    restoreSkills = materializeAgentsMd(req.cwd, skills);
    restoreMcp = materializeWorkerMcp(req.cwd, target.provider, mcp);
    result = await adapter.dispatch(req.prompt, {
      model: target.model,
      cwd: req.cwd,
      effort: req.effort ?? target.effort,
      extraFlags,
      timeoutMs: req.timeoutMs,
      resume: req.resume,
      env: { ...(req.env ?? {}), ...stamps },
      capabilities: caps.granted,
    });
  } catch (err) {
    result = { ok: false, output: '', exitCode: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { restoreMcp(); } finally { restoreSkills(); }
  }

  ctx.ledger.finish(ledgerId, {
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
    capabilities: caps.granted,
    ledgerId,
    usedFallback: fellBackFrom !== null,
    orchestrator: ctx.attribution.orchestrator,
    identitySource: ctx.attribution.identitySource,
    ...(ctx.attribution.ignoredCallerAgent ? { ignoredCallerAgent: ctx.attribution.ignoredCallerAgent } : {}),
  };
}

export async function dispatch(
  req: DispatchRequest, ledger = new Ledger(), adapterFor: AdapterFactory = defaultAdapterFor,
): Promise<DispatchOutcome> {
  const table = loadRouting();
  const identity = req.identity ?? resolveIdentity(req.cwd);
  const ctx: DispatchContext = {
    table, ledger, adapterFor, identity,
    attribution: attributeDispatch(identity, req.orchestrator),
    caps: structuralCaps(table),
  };

  // Auto-effort (opt-in): classify the sub-task's difficulty and pin the effort, unless the caller
  // already set one. Best-effort — a classifier failure falls through to the route/default effort.
  if (req.autoEffort && !req.effort) {
    const ctxLabel = req.taskClass ?? (req.provider && req.model ? `${req.provider}/${req.model}` : 'general');
    try {
      req = { ...req, effort: await classifyEffort(ctxLabel, req.prompt, req.cwd) };
    } catch { /* fall through */ }
  }

  // ---- Resolve the route + policy (HED-1 contract) -------------------------------------------
  let route: Route;
  let target: RouteTarget;
  let fallback: RouteTarget | undefined;
  if (!req.taskClass) {
    // Direct path, no class: orchestrator named the model. Full dynamic choice, still policy-fenced.
    if (!(req.provider && req.model)) {
      throw new Error('dispatch requires either a task class or an explicit provider+model');
    }
    route = directRoute(table, req.provider, req.model, req.skills, req.mcp);
    target = route;
  } else {
    route = resolveRoute(table, req.taskClass);
    if (route.requiresExplicitOptIn && !req.optIn) {
      throw new Error(
        `task class "${req.taskClass}" requires explicit opt-in` +
        (route.note ? ` — ${route.note}` : '') + '. Pass optIn/--opt-in to proceed.',
      );
    }
    if (req.provider && req.model) {
      // Class + explicit provider/model: the class supplies policy (default skills/mcp, opt-in
      // gate, ledger task_class), the named route replaces the table's — no fallback, naming it
      // is the choice. Effort is deliberately NOT inherited (per-provider vocabulary).
      const explicit = directRoute(table, req.provider, req.model, req.skills ?? route.skills, req.mcp ?? route.mcp);
      target = { ...explicit, effort: req.effort };
    } else {
      target = route;
      fallback = route.fallback;
    }
  }
  const skillsForRefusal = withMandatoryPacks(req.skills ?? target.skills ?? []);

  // ---- Structural cap: depth-1 — a worker cannot dispatch workers -----------------------------
  if (identity.worker) {
    const w = identity.worker;
    const reason =
      `depth-1 cap: this process is a heddle WORKER (HEDDLE_WORKER=1` +
      (w.dispatchId !== null ? `, dispatch #${w.dispatchId}` : '') +
      (w.parent ? `, parent ${w.parent}` : '') + `) — workers cannot dispatch workers.`;
    return refusalOutcome(ctx, req, route.taskClass, target, skillsForRefusal, {
      code: 'depth-1', reason,
      instruction: 'Finish your own task and report; ask your orchestrator to dispatch further work.',
    });
  }

  // ---- Claude-primary → structured, ledgered in-session refusal (HED-18) ----------------------
  const execution = providerExecution(table, target.provider);
  if (execution === 'in-session-subagent') {
    return refuseInSession({ ...target, taskClass: route.taskClass, fallback }, req, ctx, execution);
  }

  // ---- Run (capabilities + max-children are decided per target inside runTarget) --------------
  const primary = await runTarget(target, req, ctx, route, null);
  if (primary.ok || primary.refusal || req.noFallback || !fallback) return primary;

  // Primary failed and the table names a fallback — try it, recording the origin so the ledger
  // shows which routes actually hold up in practice.
  return runTarget(fallback, req, ctx, route, `${route.provider}/${route.model}`);
}

function refuseInSession(
  route: RouteTarget & { taskClass: string; fallback?: RouteTarget }, req: DispatchRequest,
  ctx: DispatchContext, execution: string,
): DispatchOutcome {
  const skills = withMandatoryPacks(req.skills ?? route.skills ?? []);
  const alt = route.fallback ? ` To run it as a subprocess instead, name provider+model explicitly ` +
    `(e.g. provider="${route.fallback.provider}", model="${route.fallback.model}" — the class's ` +
    `declared fallback) with the same task_class.` : '';
  const reason = (route.taskClass.startsWith('direct:')
      ? `direct route ${route.provider}/${route.model} names a provider that`
      : `task class "${route.taskClass}" routes to ${route.provider}/${route.model}, which`) +
    ` runs as an in-session subagent of the orchestrator, not a subprocess heddle can spawn.`;
  const instruction =
    `Use your own Agent tool with model "${route.model}" and skills [${skills.join(', ')}]` +
    (route.mcp?.length ? ` and MCP [${route.mcp.join(', ')}]` : '') + `.` + alt;
  return refusalOutcome(ctx, req, route.taskClass, route, skills,
    { code: 'claude-in-session', reason, instruction }, { execution });
}
