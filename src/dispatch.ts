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
import { decideCapabilities, capabilityPolicy } from './capabilities.js';
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
  code: 'claude-in-session' | 'not-dispatchable' | 'depth-1' | 'max-children' | 'capability-denied';
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
  identitySource: 'bound' | 'caller' | 'worker-parent' | null;
  /** Set when a caller-supplied `agent` disagreed with the process-bound identity (bound won). */
  ignoredCallerAgent?: string;
  /** How the provider runs workers (`in-session-subagent` = the orchestrator's own Agent tool). */
  execution?: string;
  /** Present iff heddle refused to run the dispatch (ok is then false). */
  refusal?: DispatchRefusal;
  /** Set on capability-denied refusals: which check failed (`unenforceable` means a fallback may fit). */
  capabilityRefusalKind?: 'unknown-token' | 'operator-gate' | 'opt-in' | 'unenforceable';
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
  /** Why this route ran (recorded as route_reason on later HED-67 branches; here: capability-fit notes). */
  routeReason?: string;
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

interface RefusalOpts {
  /** Outcome fields specific to this refusal path (execution, usedFallback, …). */
  extra?: Partial<DispatchOutcome>;
  /** A ledger row that already exists for this attempt (e.g. the max-children transactional row). */
  ledgerId?: number;
  fellBackFrom?: string | null;
}

function refusalOutcome(
  ctx: DispatchContext, req: DispatchRequest, taskClass: string, target: RouteTarget,
  skills: string[], refusal: DispatchRefusal, opts: RefusalOpts = {},
): DispatchOutcome {
  const { extra = {}, ledgerId, fellBackFrom = null } = opts;
  // A refusal row records what was ASKED (e.g. the denied capabilities), so the audit trail shows it.
  const id = ledgerId ?? ctx.ledger.refuse(
    baseRecord(ctx, req, taskClass, target, skills, fellBackFrom, req.capabilities ?? []),
    refusal.code, refusal.reason,
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
  const caps = decideCapabilities(target.provider, req.capabilities, req.optIn === true, capabilityPolicy(ctx.table));
  if (caps.refusal) {
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: caps.refusal.code, reason: caps.refusal.reason,
      instruction: caps.refusal.kind === 'unenforceable'
        ? 'Dispatch to a provider that can enforce it (class + explicit provider/model), or drop the capability (see docs/MODELS.md "Capabilities").'
        : 'Drop the capability, or fix the call (see docs/MODELS.md "Capabilities").',
    }, { extra: { usedFallback: fellBackFrom !== null, capabilityRefusalKind: caps.refusal.kind }, fellBackFrom });
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
    }, { extra: { usedFallback: fellBackFrom !== null }, ledgerId: started.id });
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
    // Restore is best-effort and must never keep the row from being finished (a restore failure is
    // reported in the outcome error instead).
    for (const restore of [restoreMcp, restoreSkills]) {
      try { restore(); } catch (err) {
        // Non-fatal by convention: `cleanup-warning:` on an ok=1 row means the WORK succeeded but a
        // materialized file could not be restored — inspect the worktree; the result stands.
        const note = `cleanup-warning: restore failed: ${err instanceof Error ? err.message : String(err)}`;
        result = result! ?? { ok: false, output: '', exitCode: null, error: note };
        result.error = result.error ? `${result.error}; ${note}` : note;
      }
    }
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
    execution: providerExecution(ctx.table, target.provider),
  };
}

export async function dispatch(
  req: DispatchRequest, ledger = new Ledger(), adapterFor: AdapterFactory = defaultAdapterFor,
): Promise<DispatchOutcome> {
  const table = loadRouting();
  // Identity is WHO IS RUNNING this process (its own cwd), never the worker's target directory —
  // a `.fleet-agent` planted under `--cwd` must not rename the caller.
  const identity = req.identity ?? resolveIdentity(process.cwd());
  let attribution = attributeDispatch(identity, req.orchestrator);
  // A nested attempt from inside a worker is attributed to the orchestrator that spawned it (the
  // worker has no identity of its own — parent identity vars are stripped from worker envs), and
  // marked as such, whatever else the environment claims.
  if (identity.worker) {
    attribution = { orchestrator: identity.worker.parent ?? attribution.orchestrator ?? null, identitySource: 'worker-parent' };
  }
  const ctx: DispatchContext = { table, ledger, adapterFor, identity, attribution, caps: structuralCaps(table) };

  // ---- Structural cap: depth-1 — decided before ANY resolution can throw or spend anything ----
  // A worker dispatching an opt-in class (or a malformed request) still gets a ledgered, attributed
  // depth-1 refusal, never a bare throw, and never costs a classifier spawn.
  if (identity.worker) return refuseDepth1(req, ctx, table);

  // ---- Resolve the route + policy (HED-1 contract) -------------------------------------------
  // A route override is provider AND model, or neither — a lone half would silently run the class's
  // default route (or the wrong one), so it is rejected outright.
  if (Boolean(req.provider) !== Boolean(req.model)) {
    throw new Error(
      `dispatch: provider and model must be given together (got provider=${JSON.stringify(req.provider ?? null)}, ` +
      `model=${JSON.stringify(req.model ?? null)})`,
    );
  }
  let route: Route;
  let target: RouteTarget;
  let fallback: RouteTarget | undefined;
  let origin: InSessionOrigin = 'class';
  let notDispatchable = false;
  if (!req.taskClass) {
    // Direct path, no class: orchestrator named the model. Full dynamic choice, still policy-fenced.
    if (!(req.provider && req.model)) {
      throw new Error('dispatch requires either a task class or an explicit provider+model');
    }
    route = directRoute(table, req.provider, req.model, req.skills, req.mcp);
    target = route;
    origin = 'direct';
  } else {
    route = resolveRoute(table, req.taskClass);
    if (route.requiresExplicitOptIn && !req.optIn) {
      throw new Error(
        `task class "${req.taskClass}" requires explicit opt-in` +
        (route.note ? ` — ${route.note}` : '') + '. Pass optIn/--opt-in to proceed.',
      );
    }
    // A non-dispatchable class (`orchestration`) is refused on EVERY path — a named subprocess route
    // does not turn the orchestrator's own work into a worker task. Decided here, before any route is
    // resolved, so an excluded/unknown named provider still gets the structured, ledgered refusal.
    if (!route.dispatchable) {
      // depth-1 still wins for a worker (checked below via identity) — but the plan just marks it.
      target = req.provider && req.model
        ? { ...route, provider: req.provider, model: req.model, skills: req.skills ?? route.skills, mcp: req.mcp ?? route.mcp }
        : route;
      origin = req.provider && req.model ? 'explicit' : 'class';
      notDispatchable = true;
    } else if (req.provider && req.model) {
      // Class + explicit provider/model: the class supplies policy (default skills/mcp, opt-in
      // gate, ledger task_class), the named route replaces the table's — no fallback, naming it
      // is the choice. Effort is deliberately NOT inherited (per-provider vocabulary).
      const explicit = directRoute(table, req.provider, req.model, req.skills ?? route.skills, req.mcp ?? route.mcp);
      target = { ...explicit, effort: req.effort };
      origin = 'explicit';
    } else {
      target = route;
      fallback = route.fallback;
    }
  }
  // ---- Non-dispatchable class (`orchestration`) — refused on EVERY path ------------------------
  // A named subprocess route does not turn the orchestrator's own work into a worker task. The
  // structured fields + ledger row report the route the caller actually named (target), the class
  // stays the ledger's task_class.
  if (notDispatchable) return refuseNotDispatchable({ ...route, provider: target.provider, model: target.model }, req, ctx);

  // ---- Claude-primary → structured, ledgered in-session refusal (HED-18) ----------------------
  const execution = providerExecution(table, target.provider);
  if (execution === 'in-session-subagent') {
    // The class's declared fallback rides along even on the explicit path — the instruction can still
    // name a subprocess route (class = policy).
    return refuseInSession(
      { ...target, taskClass: route.taskClass, dispatchable: route.dispatchable, fallback: route.fallback },
      req, ctx, execution, origin,
    );
  }
  // Auto-effort (opt-in): classify the sub-task's difficulty and pin the effort, unless the caller
  // already set one. Runs only after every plan-level refusal gate has passed — a refused dispatch
  // never spends a classifier (a max-children refusal can still waste one: that count is
  // transactional inside runTarget). Best-effort; failures are noted, not fatal.
  if (req.autoEffort && !req.effort) {
    try {
      req = { ...req, effort: await classifyEffort(route.taskClass, req.prompt, req.cwd) };
    } catch (err) {
      process.stderr.write(`heddle: auto-effort classification failed (${err instanceof Error ? err.message : String(err)}) — using the route default\n`);
    }
  }

  // ---- Run (capabilities + max-children are decided per target inside runTarget) --------------
  const primary = await runTarget(target, req, ctx, route, null);
  // Capability-fit fallback: when the PRIMARY provider merely lacks the knob (`unenforceable`) and
  // the class declares a fallback whose provider CAN enforce every requested capability, route there
  // — that's fit-routing, same spirit as the model fallback. Caller/operator errors stay terminal.
  if (primary.refusal?.code === 'capability-denied' && primary.capabilityRefusalKind === 'unenforceable'
      && !req.noFallback && fallback) {
    const fbCaps = decideCapabilities(fallback.provider, req.capabilities, req.optIn === true, capabilityPolicy(table));
    if (!fbCaps.refusal) {
      ctx.routeReason = `${ctx.routeReason ?? ''}; capability-fit fallback: ${target.provider} cannot enforce [${(req.capabilities ?? []).join(', ')}] → ${fallback.provider}/${fallback.model}`.replace(/^; /, '');
      const fbExec = providerExecution(table, fallback.provider);
      if (fbExec !== 'in-session-subagent') {
        return runTarget(fallback, req, ctx, route, `${route.provider}/${route.model} (capability-unenforceable)`);
      }
    }
  }
  if (primary.ok || primary.refusal || req.noFallback || !fallback) return primary;

  // Primary failed and the table names a fallback — try it, recording the origin so the ledger
  // shows which routes actually hold up in practice. A fallback that is itself in-session (custom
  // tables) gets the same structured refusal instead of a throw.
  const fbExecution = providerExecution(table, fallback.provider);
  if (fbExecution === 'in-session-subagent') {
    return refuseInSession(
      { ...fallback, taskClass: route.taskClass, dispatchable: route.dispatchable, fallback: undefined },
      req, ctx, fbExecution, 'fallback', `${route.provider}/${route.model}`,
    );
  }
  return runTarget(fallback, req, ctx, route, `${route.provider}/${route.model}`);
}

/** How the in-session route was chosen — the refusal reason must not misstate the YAML policy. */
type InSessionOrigin = 'direct' | 'class' | 'explicit' | 'fallback';

/** depth-1 refusal for a WORKER — ledgered and attributed even when the request would not have
 *  planned (opt-in gate, malformed request): the record is best-effort from the raw request. */
function refuseDepth1(req: DispatchRequest, ctx: DispatchContext, table: RoutingTable): DispatchOutcome {
  const w = ctx.identity.worker!;
  const reason =
    `depth-1 cap: this process is a heddle WORKER (HEDDLE_WORKER=1` +
    (w.dispatchId !== null ? `, dispatch #${w.dispatchId}` : '') +
    (w.parent ? `, parent ${w.parent}` : '') + `) — workers cannot dispatch workers.`;
  let taskClass = req.taskClass ?? (req.provider && req.model ? `direct:${req.provider}/${req.model}` : 'unplanned');
  let target: RouteTarget = { provider: req.provider ?? 'unknown', model: req.model ?? 'unknown', skills: req.skills, mcp: req.mcp };
  let skills = req.skills ?? [];
  try {
    if (req.taskClass && Object.prototype.hasOwnProperty.call(table.taskClasses, req.taskClass)) {
      const route = resolveRoute(table, req.taskClass);
      taskClass = route.taskClass;
      target = req.provider && req.model ? { ...route, provider: req.provider, model: req.model } : route;
      skills = route.dispatchable ? withMandatoryPacks(req.skills ?? route.skills ?? []) : (req.skills ?? route.skills ?? []);
    }
  } catch (err) {
    // Best-effort — the refusal stands regardless; but the enrichment failure is visible, not silent.
    process.stderr.write(`heddle: depth-1 refusal enrichment failed (${err instanceof Error ? err.message : String(err)}) — refusing with defaults\n`);
  }
  return refusalOutcome(ctx, req, taskClass, target, skills, {
    code: 'depth-1', reason,
    instruction: 'Finish your own task and report; ask your orchestrator to dispatch further work.',
  });
}

function refuseNotDispatchable(route: Route, req: DispatchRequest, ctx: DispatchContext): DispatchOutcome {
  const skills = req.skills ?? route.skills ?? []; // never a worker → no mandatory pack
  const reason = `task class "${route.taskClass}" is not dispatchable (dispatchable: false) — it is the ` +
    `orchestrator's own in-session work` + (req.provider && req.model ? `; naming a route (${req.provider}/${req.model}) does not change that` : '') + '.';
  const instruction = `Continue yourself; there is nothing to delegate.`;
  return refusalOutcome(ctx, req, route.taskClass, route, skills,
    { code: 'not-dispatchable', reason, instruction }, { extra: { execution: providerExecution(ctx.table, route.provider) } });
}

function refuseInSession(
  route: RouteTarget & { taskClass: string; dispatchable: boolean; fallback?: RouteTarget },
  req: DispatchRequest, ctx: DispatchContext, execution: string, origin: InSessionOrigin,
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
  const id = ctx.ledger.refuse(
    baseRecord(ctx, req, route.taskClass, route, skills, fellBackFrom), 'claude-in-session', reason,
  );
  return refusalOutcome(ctx, req, route.taskClass, route, skills,
    { code: 'claude-in-session', reason, instruction }, { extra: { execution, usedFallback: fellBackFrom !== null }, ledgerId: id });
}
