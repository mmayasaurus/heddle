import { Ledger } from './ledger.js';
import { loadRouting, providerExecution, structuralCaps, type RouteTarget } from './routing.js';
import { withMandatoryPacks } from './skillpacks.js';
import { classifyEffort } from './classify.js';
import { normalizeProvider } from './review.js';
import { fleetPauseStatus } from './fleet-pause.js';
import { decideCapabilities, capabilityPolicy } from './capabilities.js';
import { resolveIdentity, attributeDispatch } from './identity.js';
import { readProviderCaps } from './usage.js';
import { readClaudeAccounts, pickClaudeAccount, capAwarePolicy, hardRefusal } from './capaware.js';
import { classifyRotationRefusal, DEFAULT_COOLDOWN_S, DEFAULT_COOLING_PATH, readCooling, readRotationAccounts, writeCooling } from './rotation.js';
import { basename } from 'node:path';
import { defaultAdapterFor } from './dispatcher/adapters.js';
import { refusalOutcome, refuseDepth1, refuseNotDispatchable, refuseInSession } from './dispatcher/refusals.js';
import { overrideReasonGate } from './dispatcher/override-gate.js';
import { monocultureNote, formatMonocultureWarning } from './dispatcher/monoculture.js';
import { planDispatch, resolveRotationAccount, hasNoDispatchableClaudeAccount, noDispatchableClaudeAccountReason } from './dispatcher/plan.js';
import { runTarget } from './dispatcher/run.js';
import type { AdapterFactory, DispatchContext, DispatchRequest, DispatchOutcome } from './dispatcher/types.js';

// Public surface — exactly what src/dispatch.ts exported before the HED-282 split (nothing widened).
export { packsFor, requestedPacks } from './dispatcher/packs.js';
export { defaultAdapterFor } from './dispatcher/adapters.js';
export { isNonReason, overrideReasonGate } from './dispatcher/override-gate.js';
export { monocultureNote, formatMonocultureWarning } from './dispatcher/monoculture.js';
export { planDispatch, summarizePlan } from './dispatcher/plan.js';
export type { DispatchRequest, DispatchRefusal, DispatchOutcome, AdapterFactory, DispatchPlan } from './dispatcher/types.js';
export type { MonocultureNote } from './dispatcher/monoculture.js';

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

  // ---- HED-124: fleet-pause admission gate ----------------------------------------------------
  // While an operator pause is in force, refuse to ADMIT new work: a dispatch started now would be
  // orphaned by the imminent relaunch the pause exists to prepare for. Ledgered like every refusal.
  // Fail-open (see src/fleet-pause.ts): no comms broker → nobody could have paused this fleet.
  // The depth-1 check above runs FIRST on purpose — a worker's nested attempt is a depth-1 problem
  // regardless of any pause, and stays attributed as one.
  //
  // NOT atomic with the pause, and cannot be (PR #42, codeant/codex-connector): a pause recorded in
  // the microseconds between this read and startUnderCap() admits ONE dispatch it "should" have
  // stopped. That residual is by design — it is exactly what quiescence's in-flight count is for: a
  // rotator does not relaunch on a green admission gate, it relaunches on pauseReadiness reporting
  // zero in-flight dispatches, so a worker that slipped through here still blocks the rotation until
  // it finishes. The gate reduces the window from "unbounded" to "one sub-millisecond dispatch";
  // closing it fully would need a pause/dispatch lock across every heddle process, whose cost is not
  // worth removing a race the downstream in-flight check already absorbs.
  const pause = fleetPauseStatus();
  if (pause.paused) {
    const taskClass = req.taskClass ?? (req.provider && req.model ? `direct:${req.provider}/${req.model}` : 'dispatch');
    const target: RouteTarget = { provider: req.provider ?? '?', model: req.model ?? '?', skills: req.skills, mcp: req.mcp };
    return refusalOutcome(ctx, req, taskClass, target, withMandatoryPacks(req.skills ?? []), {
      code: 'fleet-paused',
      reason: `the fleet is paused${pause.reason ? ` (${pause.reason})` : ''} since ${pause.requestedAt} — new dispatches are refused until the operator resumes`,
      instruction: `An operator paused the fleet (pause #${pause.pauseId}), usually to rotate accounts or quiesce for a relaunch. ` +
        `Starting a worker now would orphan it. Wait for the operator's resume (request_pause/resume_pause are operator-only), then dispatch again.`,
    });
  }

  // ---- HED-95: the DIRECT path must say WHY it bypasses the routing table --------------------
  // Not model police: an override is one field away, and benches/probes/judgment calls are all
  // legitimate. The point is that the REASON lands in the ledger, so the routing retune (HED-79)
  // can see the distribution of why humans route around the table instead of only that they did.
  // Refused as a ledgered row (never a bare throw) so the bypass attempt is itself evidence.
  const overrideGate = overrideReasonGate(req);
  if (overrideGate) {
    return refusalOutcome(ctx, req, overrideGate.taskClass, overrideGate.target,
      withMandatoryPacks(req.skills ?? []), overrideGate.refusal(table));
  }

  // Resume affinity (HED-78): a claude session is persisted under ONE config dir — resuming it on a
  // freshly-picked account would not find the session. Pin the pick to the account the session last
  // ran under (explicit accountPin still wins; unknown session ids keep the normal pick).
  if (req.resume && !req.accountPin) {
    const prior = ledger.sessionAccount(req.resume);
    if (prior) req = { ...req, accountPin: prior };
  }

  const plan = planDispatch(req, table);
  ctx.routeReason = plan.decision.routeReason;
  ctx.account = plan.account;
  ctx.claudeAccount = plan.accountPick;
  ctx.rotationAccount = plan.rotationAccount;
  const { route, target, fallback, origin, skillsForRefusal } = plan;
  // Review rows (and the pair scoreboard) are for classes WITH reviewer semantics; a generic
  // read_only class still gets the mandate snapshot below, just no reviews row.
  if (route.reviewerPool) {
    ctx.review = {
      authorProvider: normalizeProvider(req.authorProvider) ?? null, authorModel: req.authorModel ?? null,
      authorDispatchId: req.authorDispatchId ?? null, reviewerPick: plan.reviewerPick?.reason,
    };
  }

  // ---- Non-dispatchable class (`orchestration`) — refused on EVERY path ------------------------
  // A named subprocess route does not turn the orchestrator's own work into a worker task.
  if (plan.notDispatchable) return refuseNotDispatchable({ ...route, provider: target.provider, model: target.model }, req, ctx);

  // ---- HED-3: a review by the author's own provider is refused --------------------------------
  if (plan.sameProviderReview) {
    return refusalOutcome(ctx, req, route.taskClass, target, skillsForRefusal, {
      code: 'same-provider-review', reason: plan.sameProviderReview,
      instruction: 'Omit provider/model to let the class pick a different-family reviewer from reviewer_pool, or name another provider.',
    });
  }

  // ---- Cap-aware refusal (metered pool exhausted / on-demand hard stop) ------------------------
  if (plan.decision.refusal) {
    return refusalOutcome(ctx, req, route.taskClass, target, skillsForRefusal, {
      code: 'metered-pool-exhausted', reason: plan.decision.refusal.reason,
      instruction: 'Pick a class/route on a provider with headroom (heddle route <class> shows the live decision); never on-demand billing.',
    });
  }

  // ---- Claude-primary → structured, ledgered in-session refusal (HED-18) ----------------------
  if (plan.execution === 'in-session-subagent') {
    // The class's declared fallback rides along even on the explicit path — the instruction can still
    // name a subprocess route (class = policy). Account advice (HED-68) is appended.
    return refuseInSession(
      { ...target, taskClass: route.taskClass, dispatchable: route.dispatchable, fallback: route.fallback, reviewerPool: route.reviewerPool },
      req, ctx, plan.execution, origin, plan.decision.routedAwayForCap ? `${route.provider}/${route.model}` : null,
      plan.accountAdvice,
    );
  }

  // A non-empty registry is an explicit account-routing contract. If none of its accounts is
  // addressable, never let a headless Claude worker fall through to the orchestrator's inherited
  // login; an empty registry intentionally retains that legacy inherited-login behavior.
  if (plan.pinnedExcludedAccount) {
    return refusalOutcome(ctx, req, route.taskClass, target, skillsForRefusal, {
      code: 'no-dispatchable-account',
      reason: plan.pinnedExcludedAccount.reason,
      instruction: 'Wait for a successful keeper ping or restore the pinned Claude account before dispatching it.',
    });
  }
  if (hasNoDispatchableClaudeAccount(plan)) {
    return refusalOutcome(ctx, req, route.taskClass, target, skillsForRefusal, {
      code: 'no-dispatchable-account',
      reason: noDispatchableClaudeAccountReason(plan.claudeAccountCount),
      instruction: 'An operator must restore a Claude account before this can dispatch.',
    });
  }

  // Auto-effort (opt-in): classify the sub-task's difficulty and pin the effort, unless the caller
  // already set one. Runs only after every plan-level refusal gate has passed — a refused dispatch
  // never spends a classifier (a max-children refusal can still waste one: that count is
  // transactional inside runTarget). Best-effort; failures are noted, not fatal.
  if (req.autoEffort && !req.effort) {
    try {
      req = { ...req, effort: await classifyEffort(route.taskClass, req.prompt, req.cwd, ctx.ledger) };
    } catch (err) {
      process.stderr.write(`heddle: auto-effort classification failed (${err instanceof Error ? err.message : String(err)}) — using the route default\n`);
    }
  }

  // HED-148 part B: monoculture advisory. Fires HERE — after every plan-level refusal gate above
  // (notDispatchable, same-provider, cap-aware/metered, in-session) has passed — so a direct dispatch
  // that will be REFUSED never gets a spurious nudge (gitar). Still pre-run, so it reflects the agent's
  // ESTABLISHED prior-8h direct pattern, not the dispatch being committed right now; the boundary case
  // where THIS dispatch is itself the threshold-crosser is caught by the next one. Advisory only — a
  // ledger query failure must never break the dispatch, so it is caught like the auto-effort classifier.
  if (!req.taskClass && req.provider && req.model && ctx.attribution.orchestrator) {
    try {
      const note = monocultureNote(ledger, ctx.attribution.orchestrator);
      if (note) process.stderr.write(`heddle: ${formatMonocultureWarning(note)}\n`);
    } catch (err) {
      process.stderr.write(`heddle: monoculture check failed (${err instanceof Error ? err.message : String(err)}) — skipping\n`);
    }
  }

  // ---- Run (capabilities + max-children are decided per target inside runTarget) --------------
  // A fully-cooled codex/cursor pool is NOT skipped preemptively: cooling is advisory (a heuristic from a
  // prior rate-limit that may already have reset), and a preemptive jump to the class fallback bypassed
  // both that fallback's own account selection and the HED-261 floor. Run the primary as usual — a real
  // rate-limit then cools + fails over (below), and a genuinely dead pool reaches the normal fallback path.
  let primary = await runTarget(target, req, ctx, route, plan.decision.routedAwayForCap ? `${route.provider}/${route.model}` : null);
  // Capability-fit fallback: when the PRIMARY provider merely lacks the knob (`unenforceable`) and
  // the class declares a fallback whose provider CAN enforce every requested capability, route there
  // — that's fit-routing, same spirit as the model fallback. Caller/operator errors stay terminal;
  // for a review class the fallback must still not be the author's family.
  if (primary.refusal?.code === 'capability-denied' && primary.capabilityRefusalKind === 'unenforceable'
      && !req.noFallback && fallback
      && !(route.reviewerPool && normalizeProvider(fallback.provider) === normalizeProvider(req.authorProvider))) {
    const fallbackCapabilities = [...new Set([...(fallback.capabilities ?? []), ...(req.capabilities ?? [])])];
    const fbCaps = decideCapabilities(fallback.provider, fallbackCapabilities, req.optIn === true, capabilityPolicy(table));
    if (!fbCaps.refusal && providerExecution(table, fallback.provider) !== 'in-session-subagent') {
      const targetCapabilities = [...new Set([...(target.capabilities ?? []), ...(req.capabilities ?? [])])];
      ctx.routeReason = `${plan.decision.routeReason}; capability-fit fallback: ${target.provider} cannot enforce [${targetCapabilities.join(', ')}] → ${fallback.provider}/${fallback.model}`;
      if (fallback.provider === 'codex' || fallback.provider === 'cursor') {
        const registry = req.rotationAccounts ?? readRotationAccounts();
        ctx.rotationAccount = resolveRotationAccount(fallback, req, registry, readCooling(req.coolingPath ?? DEFAULT_COOLING_PATH));
        ctx.account = ctx.rotationAccount?.id ?? (fallback.provider === 'codex' && req.env?.CODEX_HOME ? basename(req.env.CODEX_HOME) : null);
        if (ctx.rotationAccount) ctx.routeReason += `; ${ctx.rotationAccount.reason}`;
      }
      return runTarget(fallback, req, ctx, route, `${route.provider}/${route.model} (capability-unenforceable)`);
    }
  }
  // A read-only MANDATE VIOLATION is a policy failure of the reviewer, not a provider failure — never
  // "retry" it on the fallback (that would re-run in an already-mutated tree and mask the violation).
  if (primary.ok || primary.refusal || primary.review?.mandateOk === false) return primary;
  if (req.noFallback) {
    if ((target.provider === 'codex' || target.provider === 'cursor') && ctx.rotationAccount
        && classifyRotationRefusal(target.provider, primary) === 'rate-limit') {
      const coolingPath = req.coolingPath ?? DEFAULT_COOLING_PATH;
      const cooling = readCooling(coolingPath);
      cooling.lanes[`${target.provider}:${ctx.rotationAccount.id}`] = { cooledAt: req.nowS ?? Math.floor(Date.now() / 1000), reason: 'rate-limit', cooldownS: DEFAULT_COOLDOWN_S };
      writeCooling(coolingPath, cooling);
    }
    return primary;
  }

  // HED-268: a clear provider quota refusal cools the selected codex/cursor account and gets ONE
  // same-provider retry before the class's normal provider fallback. Generic failures never rotate.
  if ((target.provider === 'codex' || target.provider === 'cursor') && ctx.rotationAccount
      && classifyRotationRefusal(target.provider, primary) === 'rate-limit') {
    const coolingPath = req.coolingPath ?? DEFAULT_COOLING_PATH;
    const cooling = readCooling(coolingPath);
    const from = ctx.rotationAccount.id;
    cooling.lanes[`${target.provider}:${from}`] = { cooledAt: req.nowS ?? Math.floor(Date.now() / 1000), reason: 'rate-limit', cooldownS: DEFAULT_COOLDOWN_S };
    writeCooling(coolingPath, cooling);
    const retry = resolveRotationAccount(target, req, req.rotationAccounts ?? readRotationAccounts(), cooling);
    if (retry && retry.id !== from) {
      ctx.rotationAccount = retry; ctx.account = retry.id;
      ctx.routeReason = `${plan.decision.routeReason}; account-failover:${from}→${retry.id} (rate-limit); ${retry.reason}`;
      let retryOutcome = await runTarget(target, req, ctx, route, `${target.provider}/${target.model} (account-failover)`);
      if (primary.destroyed && !retryOutcome.destroyed) retryOutcome = { ...retryOutcome, destroyed: primary.destroyed };
      else if (primary.destroyed && retryOutcome.destroyed) {
        retryOutcome = { ...retryOutcome, destroyed: { ...retryOutcome.destroyed, note: `${primary.destroyed.note}; then ${retryOutcome.destroyed.note}` } };
      }
      if (primary.escape && !retryOutcome.escape) retryOutcome = { ...retryOutcome, escape: primary.escape };
      else if (primary.escape && retryOutcome.escape) {
        retryOutcome = { ...retryOutcome, escape: { ...retryOutcome.escape, note: `${primary.escape.note}; then ${retryOutcome.escape.note}` } };
      }
      primary = retryOutcome;
      if (primary.ok || primary.refusal || primary.review?.mandateOk === false || req.noFallback) return primary;
      if (classifyRotationRefusal(target.provider, primary) === 'rate-limit') {
        cooling.lanes[`${target.provider}:${retry.id}`] = { cooledAt: req.nowS ?? Math.floor(Date.now() / 1000), reason: 'rate-limit', cooldownS: DEFAULT_COOLDOWN_S };
        writeCooling(coolingPath, cooling);
      }
    }
  }

  if (!fallback) return primary;

  // Primary failed and the table names a fallback — try it, recording the origin so the ledger
  // shows which routes actually hold up in practice. A fallback that is itself in-session (custom
  // tables) gets the same structured refusal instead of a throw.
  if (route.reviewerPool && normalizeProvider(fallback.provider) === normalizeProvider(req.authorProvider)) return primary; // never review with the author's family
  const fbExecution = fallback.provider === 'claude'
    ? (req.inSession ? 'in-session-subagent' : 'headless')
    : providerExecution(table, fallback.provider);
  if (fbExecution === 'in-session-subagent') {
    return refuseInSession(
      { ...fallback, taskClass: route.taskClass, dispatchable: route.dispatchable, fallback: undefined, reviewerPool: route.reviewerPool },
      req, ctx, fbExecution, 'fallback', `${route.provider}/${route.model}`, plan.accountAdvice,
    );
  }
  // The never-on-demand HARD guard applies to the runtime fallback too: a below-threshold primary
  // failing over to cursor must not bypass an on-demand stop the plan never evaluated for it.
  const fbSnap = req.caps ?? readProviderCaps();
  const fbHard = hardRefusal(fallback, fbSnap);
  if (fbHard) {
    return refusalOutcome(ctx, req, route.taskClass, fallback, skillsForRefusal, {
      code: 'metered-pool-exhausted', reason: `failure fallback blocked: ${fbHard}`,
      instruction: 'The primary failed and the class fallback would bill on-demand — pick another route (heddle route <class>).',
    }, { extra: { usedFallback: true } });
  }
  // Attribution AND account selection follow the provider that actually runs: a codex fallback
  // bills its CODEX_HOME; a CLAUDE fallback gets its own headroom-based account pick (the plan only
  // picked for a claude PRIMARY — without this the subprocess would inherit the caller's
  // CLAUDE_CONFIG_DIR and the ledger account would be wrong; PR #12, five reviewers).
  if (fallback.provider === 'claude') {
    try {
      // forFable on the RUNTIME fallback too: a claude/fable fallback must be picked by Fable
      // headroom, not 5h (PR #24, codeant).
      const fallbackAccounts = req.accounts ?? readClaudeAccounts();
      ctx.claudeAccount = pickClaudeAccount(fbSnap.claude, fallbackAccounts,
        { pin: req.accountPin, routeAwayAtPct: capAwarePolicy(table).routeAwayAtPct, forFable: fallback.model === 'fable' }) ?? null;
      ctx.account = ctx.claudeAccount?.account.id ?? null;
      if (fallbackAccounts.length > 0 && ctx.claudeAccount === null) {
        const note = `claude fallback blocked: no dispatchable account — ${noDispatchableClaudeAccountReason(fallbackAccounts.length)}`;
        const base = primary.error?.trim() ? primary.error : '';
        primary.error = base ? `${base}; ${note}` : note;
        try {
          ledger.annotateError(primary.ledgerId, note);
        } catch {
          // best-effort: a ledger write failure must not abort or misclassify the dispatch
        }
        return primary;
      }
    } catch (err) {
      // A pinned-but-unaddressable account is a caller error, but the primary's outcome is already
      // ledgered — report the blocked fallback on it instead of throwing away the whole dispatch.
      const note = `claude fallback blocked: ${err instanceof Error ? err.message : String(err)}`;
      const base = primary.error?.trim() ? primary.error : '';
      primary.error = base ? `${base}; ${note}` : note;
      try {
        ledger.annotateError(primary.ledgerId, note);
      } catch {
        // best-effort: a ledger write failure must not abort or misclassify the dispatch
      }
      return primary;
    }
  } else {
    ctx.claudeAccount = null;
    if (fallback.provider === 'codex' || fallback.provider === 'cursor') {
      const registry = req.rotationAccounts ?? readRotationAccounts();
      ctx.rotationAccount = resolveRotationAccount(fallback, req, registry, readCooling(req.coolingPath ?? DEFAULT_COOLING_PATH));
      ctx.account = ctx.rotationAccount?.id ?? (fallback.provider === 'codex' && req.env?.CODEX_HOME ? basename(req.env.CODEX_HOME) : null);
    } else {
      ctx.rotationAccount = null;
      ctx.account = null;
    }
  }
  // The account pick's REASON rides along too (the plan path already does this): without it a
  // runtime-fallback row records which account ran but never why it was chosen — the fable-headroom
  // / 5h-headroom evidence the scoreboard is built on (PR #24, found by the dispatched test worker).
  ctx.routeReason = `${ctx.routeReason ?? plan.decision.routeReason}; ${target.provider}/${target.model} failed → class fallback`
    + (ctx.claudeAccount ? `; ${ctx.claudeAccount.reason}` : ctx.rotationAccount ? `; ${ctx.rotationAccount.reason}` : '');
  let fbOutcome = await runTarget(fallback, req, ctx, route, `${route.provider}/${route.model}`);
  // A PRIMARY that escaped its worktree and then FAILED must not have that warning discarded when
  // the fallback succeeds — the parent checkout is still dirty and someone has to know (PR #28).
  // A primary that destroyed work and THEN failed must not have that warning discarded when the
  // fallback succeeds — the tree is still wrecked and someone has to know (PR #40, 2 reviewers).
  if (primary.destroyed && !fbOutcome.destroyed) fbOutcome = { ...fbOutcome, destroyed: primary.destroyed };
  else if (primary.destroyed && fbOutcome.destroyed) {
    fbOutcome = { ...fbOutcome, destroyed: { ...fbOutcome.destroyed, note: `${primary.destroyed.note}; then ${fbOutcome.destroyed.note}` } };
  }
  if (primary.escape && !fbOutcome.escape) return { ...fbOutcome, escape: primary.escape };
  if (primary.escape && fbOutcome.escape) {
    return { ...fbOutcome, escape: { ...fbOutcome.escape, note: `${primary.escape.note}; then ${fbOutcome.escape.note}` } };
  }
  return fbOutcome;
}
