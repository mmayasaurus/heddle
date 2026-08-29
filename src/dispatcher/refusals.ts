/**
 * Refusal paths — every way dispatch() declines to run a worker, each a finished ledger row (never a
 * silent no-op, never in flight). Moved verbatim from src/dispatch.ts (HED-282).
 */
import type { DispatchStartRecord } from '../ledger.js';
import { resolveRoute, providerExecution, type Route, type RouteTarget, type RoutingTable } from '../routing.js';
import type { AccountAdvice } from '../capaware.js';
import { packsFor, requestedPacks } from './packs.js';
import type { DispatchContext, DispatchRequest, DispatchOutcome, DispatchRefusal, RefusalOpts, InSessionOrigin } from './types.js';

export function baseRecord(
  ctx: DispatchContext, req: DispatchRequest, taskClass: string, target: RouteTarget,
  skills: string[], fellBackFrom: string | null, capabilities: string[] = [],
): DispatchStartRecord {
  return {
    orchestrator: ctx.attribution.orchestrator,
    identitySource: ctx.attribution.identitySource,
    overrideReason: req.overrideReason?.trim() || null,
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
    routeReason: ctx.routeReason ?? null,
    account: ctx.account ?? null,
  };
}

export function refusalOutcome(
  ctx: DispatchContext, req: DispatchRequest, taskClass: string, target: RouteTarget,
  skills: string[], refusal: DispatchRefusal, opts: RefusalOpts = {},
): DispatchOutcome {
  const { extra = {}, ledgerId, fellBackFrom = null, capabilities } = opts;
  // A refusal row records what was ASKED (e.g. the denied capabilities), so the audit trail shows it —
  // the EFFECTIVE list (class defaults ∪ req) when the caller passed one, else req.capabilities.
  const id = ledgerId ?? ctx.ledger.refuse(
    baseRecord(ctx, req, taskClass, target, skills, fellBackFrom, capabilities ?? req.capabilities ?? []),
    refusal.code, refusal.reason,
  );
  return {
    ok: false, output: '', exitCode: null,
    error: refusal.instruction ? `${refusal.reason} ${refusal.instruction}` : refusal.reason,
    taskClass, provider: target.provider, model: target.model, skills, capabilities: [],
    ledgerId: id, usedFallback: false,
    orchestrator: ctx.attribution.orchestrator, identitySource: ctx.attribution.identitySource,
    ...(ctx.attribution.ignoredCallerAgent ? { ignoredCallerAgent: ctx.attribution.ignoredCallerAgent } : {}),
    routeReason: ctx.routeReason, account: ctx.account ?? null,
    refusal, ...extra,
  };
}

/** The requiresWeb guard's refusal reason — shared by runTarget (enforcement) and planDispatch (dry
 *  run) so a `heddle route` / plan_dispatch preview can't advertise a web-research route the real
 *  dispatch would immediately refuse (codex #76). One source of truth for the wording. */
export function webRefusalReason(taskClass: string, provider: string): string {
  return `the "${taskClass}" class requires a web-capable provider; "${provider}" has no intrinsic grounding or enforceable "browse" grant.`;
}

/** depth-1 refusal for a WORKER — ledgered and attributed even when the request would not have
 *  planned (opt-in gate, malformed request): the record is best-effort from the raw request. */
export function refuseDepth1(req: DispatchRequest, ctx: DispatchContext, table: RoutingTable): DispatchOutcome {
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
      // Same list a real dispatch would materialize (packsFor), not just the mandatory union —
      // a refusal that names a different set is the dry-run-lies bug in another costume (PR #34).
      skills = route.dispatchable ? packsFor(target.provider, requestedPacks(route.reviewerPool, route.skills, req.skills), req.cwd) : (req.skills ?? route.skills ?? []);
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

export function refuseNotDispatchable(route: Route, req: DispatchRequest, ctx: DispatchContext): DispatchOutcome {
  const skills = req.skills ?? route.skills ?? []; // never a worker → no mandatory pack
  const reason = `task class "${route.taskClass}" is not dispatchable (dispatchable: false) — it is the ` +
    `orchestrator's own in-session work` + (req.provider && req.model ? `; naming a route (${req.provider}/${req.model}) does not change that` : '') + '.';
  const instruction = `Continue yourself; there is nothing to delegate.`;
  return refusalOutcome(ctx, req, route.taskClass, route, skills,
    { code: 'not-dispatchable', reason, instruction }, { extra: { execution: providerExecution(ctx.table, route.provider) } });
}

export function refuseInSession(
  route: RouteTarget & { taskClass: string; dispatchable: boolean; fallback?: RouteTarget; reviewerPool?: Route['reviewerPool'] },
  req: DispatchRequest, ctx: DispatchContext, execution: string, origin: InSessionOrigin,
  fellBackFrom: string | null = null, accountAdvice?: AccountAdvice,
): DispatchOutcome {
  // (Non-dispatchable classes never reach here — refuseNotDispatchable handles them earlier.)
  // This instruction tells the orchestrator which packs to hand its OWN subagent, so it must name
  // exactly what a dispatch to that provider would materialize — family pack included (PR #34).
  const skills = packsFor(route.provider, requestedPacks(route.reviewerPool, route.skills, req.skills), req.cwd);
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
  // This row describes what will actually run in the orchestrator's session, not the account that
  // would have been best for a separate headless worker.
  const record = { ...baseRecord(ctx, req, route.taskClass, route, skills, fellBackFrom), account: accountAdvice?.current?.id ?? null };
  const id = ctx.ledger.refuse(
    record, 'claude-in-session', reason, 'in-session',
  );
  // This review row links to dispatch id `id`; it counts only once the handoff is CONFIRMED
  // (report_in_session clears the refusal), so an unreported handoff never inflates the pair
  // stats — mirroring how the dispatch row itself stays a refusal until reported (HED-122/HED-99).
  if (ctx.review) {
    // The review row is a SECONDARY audit artifact; the refusal row above is already committed, so a
    // recordReview failure (e.g. a caller-supplied malformed authorDispatchId) must NOT orphan that
    // handoff or throw away the whole dispatch — the two writes are not atomic (codeant/codex). Keep
    // the handoff whole and skip only the review-pair audit for this one row.
    try {
      ctx.ledger.recordReview({
        dispatchId: id, authorProvider: ctx.review.authorProvider, authorModel: ctx.review.authorModel,
        authorDispatchId: ctx.review.authorDispatchId, reviewerProvider: route.provider, reviewerModel: route.model,
      });
    } catch (err) {
      process.stderr.write(`heddle: could not record the in-session review row for dispatch #${id} ` +
        `(${err instanceof Error ? err.message : String(err)}) — the handoff stands; only its review-pair audit is skipped\n`);
    }
  }
  const instruction =
    `Use your own Agent tool with model "${route.model}" and skills [${skills.join(', ')}]` +
    (mcp.length ? ` and MCP [${mcp.join(', ')}]` : '') + `.` + alt +
    (accountAdvice ? ` ${accountAdvice.line}` : '') +
    ` When it finishes, report the outcome so it counts: report_in_session(id=${id}, ok=true|false, and the token counts if you have them) — or \`heddle ledger report-in-session ${id} --ok\`. Until it is reported this row stays a refusal and the work is not counted.`;
  return refusalOutcome(ctx, req, route.taskClass, route, skills,
    { code: 'claude-in-session', reason, instruction }, { extra: { execution, usedFallback: fellBackFrom !== null }, ledgerId: id });
}
