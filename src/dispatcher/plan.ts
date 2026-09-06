/**
 * The dry-run half of dispatch(): planDispatch() + summarizePlan() and the Claude-account helpers
 * they share with dispatch(). Moved verbatim from src/dispatch.ts (HED-282).
 */
import { basename } from 'node:path';
import { loadRouting, resolveRoute, directRoute, providerExecution, providerConfig, type Route, type RouteTarget, type RoutingTable } from '../routing.js';
import { loadLanes, type LanesConfig } from '../lanes.js';
import { mcpAttachable, webCapable } from '../mcp.js';
import { pickReviewer, normalizeProvider, type ReviewerPick } from '../review.js';
import { decideCapabilities, capabilityPolicy } from '../capabilities.js';
import { readProviderCaps } from '../usage.js';
import { loadAccountRegistry, type Account } from '../accounts.js';
import {
  decideRoute, readClaudeAccounts, adviseClaudeAccount, pickClaudeAccount, capAwarePolicy, accountAtOrOverCap,
  type RouteDecision, type ClaudeAccount, type AccountAdvice, type AccountPick,
} from '../capaware.js';
import {
  pickCodexAccount, pickCursorAccount, readCursorKey, readRotationAccounts, readCooling, DEFAULT_COOLING_PATH,
  type RotationAccounts,
} from '../rotation.js';
import { packsFor, requestedPacks } from './packs.js';
import { overrideReasonGate } from './override-gate.js';
import { webRefusalReason } from './refusals.js';
import type { DispatchContext, DispatchRequest, DispatchPlan, DispatchRefusal, InSessionOrigin } from './types.js';

const PAY_PER_TOKEN_PERMIT = 'policy.cap_aware_routing.permit_pay_per_token: true';

function billingDecision(account: Account | undefined, atCap: boolean, permitPayPerToken: boolean): {
  refusal?: DispatchRefusal; advice?: string;
} {
  if (!account?.billingClass) return {};
  const identity = `selected account "${account.id}" (billingClass=${account.billingClass}`;
  if (account.billingClass === 'pay-per-token' && !permitPayPerToken) {
    return { refusal: {
      code: 'billing.pay-per-token',
      reason: `${identity}) bills from token 1 and is refused by default.`,
      instruction: `To explicitly permit this account, set ${PAY_PER_TOKEN_PERMIT}.`,
    } };
  }
  const posture = account.overage?.posture;
  if (posture === 'open-billing' && atCap) {
    return { refusal: {
      code: 'billing.open-billing-at-cap',
      reason: `${identity}, overage.posture=open-billing) is at or over its five-hour cap and would enter paid overage.`,
      instruction: `No switch overrides open-billing at cap; ${PAY_PER_TOKEN_PERMIT} is the exact pay-per-token permit lever and does not permit this posture. Select an account with headroom or change its overage posture.`,
    } };
  }
  if (posture === 'bounded-prepaid') {
    if (account.overage?.creditsRemaining === 0) {
      return { refusal: {
        code: 'billing.prepaid-exhausted',
        reason: `${identity}, overage.posture=bounded-prepaid) has credits exhausted.`,
        instruction: `No switch overrides exhausted prepaid credit; ${PAY_PER_TOKEN_PERMIT} is the exact pay-per-token permit lever and does not replenish this account. Add prepaid credit or select another account.`,
      } };
    }
    if (atCap) return { advice: `burning prepaid buffer (${account.overage?.creditsRemaining} of ${account.overage?.spendLimit})` };
  }
  return {};
}

export function hasNoDispatchableClaudeAccount(plan: Pick<DispatchPlan,
  'target' | 'execution' | 'notDispatchable' | 'claudeAccountCount' | 'accountPick'>,
): boolean {
  return plan.target.provider === 'claude'
    && plan.execution !== 'in-session-subagent'
    && !plan.notDispatchable
    && plan.claudeAccountCount > 0
    && plan.accountPick === null;
}

export function noDispatchableClaudeAccountReason(accountCount: number): string {
  const registry = accountCount === 1
    ? 'the 1 registered account is'
    : `all ${accountCount} registered accounts are`;
  return `no dispatchable Claude account — ${registry} logged-out or non-dispatchable ` +
    '(a billing/logged-out signal, or a replaced credential). Run `claude /login` on the affected account and update accounts.json, or wait for a keeper ping to clear the signal.';
}

export function excludedClaudePin(err: unknown): { pin: string; reason: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^account_pin "([^"]+)" is registered but NOT dispatchable \(([^)]+)\)/.exec(message);
  return match ? { pin: match[1], reason: message } : null;
}

export function resolveRotationAccount(target: RouteTarget, req: DispatchRequest, registry: RotationAccounts, cooling: ReturnType<typeof readCooling>): DispatchContext['rotationAccount'] {
  const nowS = req.nowS ?? Math.floor(Date.now() / 1000);
  // HED-392 will recover the original account from the ledger; until then, resumed sessions stay on an explicit home or the default login.
  if (req.resume) {
    if (target.provider === 'codex') {
      const pick = req.env?.CODEX_HOME ? pickCodexAccount(registry, cooling, req.env.CODEX_HOME, nowS) : null;
      return pick ? { provider: 'codex', id: pick.id, env: { CODEX_HOME: pick.codexHome ?? req.env!.CODEX_HOME! }, unset: [], reason: pick.reason }
        : { provider: 'codex', id: 'default', env: {}, unset: ['CODEX_HOME'], reason: 'account:default resumed default login' };
    }
    if (target.provider === 'cursor') {
      const explicitKey = req.env?.CURSOR_API_KEY;
      if (explicitKey) {
        const matched = registry.cursor.find((account) => account.keyFile !== null && readCursorKey(account.keyFile) === explicitKey);
        return { provider: 'cursor', id: matched?.id ?? 'manual', env: { CURSOR_API_KEY: explicitKey }, unset: [], reason: `account:${matched?.id ?? 'manual'} resumed explicit key` };
      }
      const machine = registry.cursor.find((account) => account.keyFile === null);
      return { provider: 'cursor', id: machine?.id ?? 'default', env: {}, unset: ['CURSOR_API_KEY'], reason: `account:${machine?.id ?? 'default'} resumed machine login` };
    }
  }
  if (target.provider === 'codex') {
    const pick = pickCodexAccount(registry, cooling, req.env?.CODEX_HOME, nowS);
    return pick ? { provider: 'codex', id: pick.id, env: pick.codexHome ? { CODEX_HOME: pick.codexHome } : {}, unset: pick.codexHome ? [] : ['CODEX_HOME'], reason: pick.reason } : null;
  }
  if (target.provider === 'cursor') {
    const unavailable = new Set<string>();
    for (;;) {
      const pick = pickCursorAccount(target.model, registry, cooling, nowS, unavailable);
      if (!pick) return null;
      if (pick.keyFile === null) return { provider: 'cursor', id: pick.id, env: {}, unset: ['CURSOR_API_KEY'], reason: pick.reason };
      const key = readCursorKey(pick.keyFile);
      if (key) return { provider: 'cursor', id: pick.id, env: { CURSOR_API_KEY: key }, unset: [], reason: pick.reason };
      unavailable.add(pick.id);
      process.stderr.write(`heddle: Cursor account ${pick.id} skipped — key file unavailable (${pick.keyFile})\n`);
    }
  }
  return null;
}

/**
 * The dry-run half of dispatch(): resolves the class/route contract (HED-1), applies cap-aware
 * routing (HED-67) and Claude account advice (HED-68) — no ledger row, no worker. Used by
 * dispatch() itself and by `heddle route` / the `plan_dispatch` MCP tool.
 */
export function planDispatch(req: DispatchRequest, table: RoutingTable = loadRouting()): DispatchPlan {
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
  let reviewerPick: ReviewerPick | null = null;
  let sameProviderReview: string | undefined;
  const author = normalizeProvider(req.authorProvider);
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
      // Class capabilities are POLICY, like skills/mcp: the named route replaces provider/model but
      // inherits the class's capability defaults (the caller may still ADD via req.capabilities — the
      // union in runTarget — but naming a provider must not SILENTLY DROP them, per the contract at the
      // requestedCapabilities union). Otherwise a `capabilities:[browse]` class dispatched explicitly
      // would spuriously refuse or shed its web requirement (cubic P1 / codex #76). requiresWeb stays on
      // the class `route` the guard already reads; only the grantable defaults live on the target.
      target = { ...explicit, effort: req.effort, capabilities: route.capabilities };
      origin = 'explicit';
    } else {
      target = route;
      fallback = route.fallback;
      // HED-3: when the class primary is the author's provider, take the first differing pool entry.
      const pick = route.reviewerPool
        ? pickReviewer(route, author, (provider, model, entryMcp) => {
            const cfg = providerConfig(table, provider); // own-property: a `toString` entry is unknown, not the prototype method (cubic #63)
            if (!cfg) return 'unknown provider';
            if (cfg.status === 'excluded') return 'provider excluded by policy';
            if (cfg.status === 'held') return 'provider on hold and not routable yet'; // uniform held check (qodo #63)
            // HED-249: a picked reviewer inherits the EFFECTIVE mcp (an explicit req.mcp overrides the
            // class default — cubic #73), so an mcp-carrying dispatch must SKIP a reviewer that can't
            // attach THAT list (else pickReviewer selects it and validateWorkerMcp then hard-fails).
            // Skip → next capable reviewer, or refuse if none — never run a reviewer without discovery.
            // Validates the actual list, so `['serena']` on cursor is caught, not just gemini+memtrace.
            const effMcp = req.mcp ?? entryMcp ?? route.mcp ?? [];
            if (effMcp.length > 0 && !mcpAttachable(provider, effMcp)) return 'cannot attach the class mcp';
            if (Array.isArray(cfg.models) && cfg.models.length && !cfg.models.includes(model)) return 'model not in provider list';
            return null;
          })
        : null;
      if (pick) {
        reviewerPick = pick;
        target = { ...route, provider: pick.provider, model: pick.model, mcp: pick.mcp ?? route.mcp };
        // a fallback identical to the pick would just re-run the same reviewer — drop it
        if (fallback && fallback.provider === pick.provider && fallback.model === pick.model) fallback = undefined;
      }
    }
    // HED-3 review classes: the author's family never reviews — not as the named route, not as the
    // class fallback, and (below, after cap-aware routing) not as the effective target.
    if (route.reviewerPool && fallback && normalizeProvider(fallback.provider) === author) fallback = undefined;
  }

  // Cap-aware routing (HED-67): may swap target→fallback, or refuse a metered pool. Explicit routes
  // are never routed away (naming it is the choice) but the refusals still apply.
  const caps = req.caps ?? readProviderCaps();
  // Memoized registry read: at most one accounts.json read per plan, and none at all for routes
  // that never consult it (PR #24 — the eager read hit every codex/cursor/gemini dispatch).
  let claudeAccountsCache: ClaudeAccount[] | undefined;
  const claudeAccounts = (): ClaudeAccount[] => (claudeAccountsCache ??= req.accounts ?? readClaudeAccounts());
  // Lanes are read LAZILY too (HED-106): the tier-ladder walk only fires when a class's declared route
  // is genuinely dead, so a healthy / codex / cursor plan pays no lanes.yaml read (same PR #24 discipline).
  let lanesCache: LanesConfig | undefined;
  const lanesFn = (): LanesConfig => (lanesCache ??= loadLanes());
  // A non-dispatchable class is refused regardless, so no cap decision is made for it.
  const decision: RouteDecision = notDispatchable
    ? { target, fallback, routedAwayForCap: false, routeReason: 'not-dispatchable', checks: ['class is dispatchable: false — refused before any route'] }
    : decideRoute(table, target, fallback, caps, {
        explicit: origin !== 'class', accountPin: req.accountPin,
        // Memoized thunk: accounts.json is read AT MOST once per plan, and never for a route that
        // does not consult it (codex/cursor/gemini plans do zero disk IO here — PR #24).
        claudeAccounts: () => claudeAccounts(),
        // HED-106 tier-ladder: when this class's declared route is genuinely dead (S1: a claude route
        // with no addressable account), expand across lanes.yaml instead of refusing (HED-264). Bounds
        // come from the class; the author family is excluded for review classes; lanes read lazily.
        // NEVER for an in-session dispatch: in-session runs on the orchestrator's OWN account (it needs
        // no dispatchable worker account), so a dead-account walk to a headless codex would wrongly
        // replace the claude-in-session instruction — the ladder is a HEADLESS-worker mechanism only.
        ladder: req.inSession ? undefined : {
          lanes: lanesFn,
          laneDefaults: table.laneDefaults ?? {},
          declaredProvider: route.provider,
          minTier: route.minTier,
          maxTier: route.maxTier,
          editsCode: route.editsCode,
          requiresWeb: route.requiresWeb,
          mcp: req.mcp ?? route.mcp ?? [],
          skills: route.skills ?? [],
          // The EFFECTIVE granted set (class defaults ∪ caller's) — the same union runTarget grants — so
          // the walk's webCapable filter judges a candidate on the caps it would actually run with, not
          // just the class defaults (a caller's `browse` must let a web class expand to codex; HED-106 review).
          grantedCapabilities: [...new Set([...(target.capabilities ?? []), ...(req.capabilities ?? [])])],
          excludeProviders: route.reviewerPool && author ? [author] : [],
        },
      });
  target = decision.target;
  fallback = decision.fallback;
  if (reviewerPick) decision.routeReason = `${decision.routeReason}; reviewer ${reviewerPick.reason}`;
  // HED-3 invariant, checked on the EFFECTIVE target (after explicit route / pool pick / cap-aware
  // route-away): a review class never runs on the author's family. author_provider is REQUIRED for
  // review classes — an orchestrator reviewing its own edits passes 'claude'.
  if (route.reviewerPool && !notDispatchable) {
    if (author && !table.providers[author]) {
      throw new Error(
        `task class "${route.taskClass}": author_provider "${author}" is not a known provider ` +
        `(${Object.keys(table.providers).join(', ')}) — a typo here would silently disable the ` +
        `different-family guard, so it is rejected.`,
      );
    }
    if (!author) {
      throw new Error(
        `task class "${route.taskClass}" requires author_provider (the provider that WROTE the change — for your ` +
        `own edits, "claude"): the reviewer must be a different model family, and the pair is what the ledger scores.`,
      );
    }
    if (target.provider === author) {
      sameProviderReview = `task class "${route.taskClass}" requires a reviewer from a DIFFERENT provider than the ` +
        `author (${author}); the effective route ${target.provider}/${target.model} is the author's own family` +
        (origin === 'explicit' ? ' (named explicitly)' : decision.routedAwayForCap ? ' (cap-aware route-away landed there)' : '') + '.';
    }
  }

  // Claude runs headless by default (HED-78); `inSession` keeps the shared-cache subagent protocol.
  const execution = target.provider === 'claude'
    ? (req.inSession ? 'in-session-subagent' : 'headless')
    : providerExecution(table, target.provider);
  // Same list the worker would actually get, family pack included — a refusal or dry run that
  // advertises a different set than runTarget materializes is a lie the operator acts on (PR #34).
  const skillsForRefusal = packsFor(target.provider, requestedPacks(route.reviewerPool, target.skills, req.skills), req.cwd);

  // Account (HED-68/78): codex → the CODEX_HOME the caller selected; claude → the registry account
  // with the most 5h headroom (headless worker) — or advice only when the caller wants in-session.
  let account: string | null = null;
  let accountAdvice: AccountAdvice | undefined;
  let accountPick: AccountPick | null | undefined;
  let rotationAccount: DispatchContext['rotationAccount'];
  let claudeAccountCount = 0;
  let pinnedExcludedAccount: { pin: string; reason: string } | undefined;
  if (target.provider === 'codex' || target.provider === 'cursor') {
    const registry = req.rotationAccounts ?? readRotationAccounts();
    rotationAccount = resolveRotationAccount(target, req, registry, readCooling(req.coolingPath ?? DEFAULT_COOLING_PATH));
    account = rotationAccount?.id ?? (target.provider === 'codex' && req.env?.CODEX_HOME ? basename(req.env.CODEX_HOME) : null);
    if (rotationAccount) decision.routeReason = `${decision.routeReason}; ${rotationAccount.reason}`;
  }
  if (target.provider === 'claude') {
    const accounts = claudeAccounts();
    claudeAccountCount = accounts.length;
    accountAdvice = adviseClaudeAccount(caps.claude, accounts);
    if (!req.inSession && !notDispatchable) {
      try {
        accountPick = pickClaudeAccount(caps.claude, accounts, { pin: req.accountPin, routeAwayAtPct: capAwarePolicy(table).routeAwayAtPct, forFable: target.model === 'fable' });
      } catch (err) {
        const excludedPin = excludedClaudePin(err);
        if (!excludedPin) throw err;
        pinnedExcludedAccount = excludedPin;
        accountPick = null;
      }
      account = accountPick?.account.id ?? null;
      if (accountPick) decision.routeReason = `${decision.routeReason}; ${accountPick.reason}`;
    } else {
      account = accountAdvice.best?.id ?? null;
    }
  }
  const richAccount = account === null
    ? undefined
    : loadAccountRegistry().accounts.find((candidate) => candidate.provider === target.provider && candidate.id === account);
  const billing = billingDecision(
    richAccount,
    account !== null && accountAtOrOverCap(caps[target.provider], account),
    capAwarePolicy(table).permitPayPerToken,
  );
  const billingRefusal = billing.refusal;
  const billingAdvice = billing.advice;
  if (billingAdvice) {
    decision.checks.push(billingAdvice);
    decision.routeReason = `${decision.routeReason}; ${billingAdvice}`;
  }
  // The dry run must mirror what dispatch() would do — including refusing a bare direct route.
  const gate = overrideReasonGate(req);
  const overrideReasonRequired = gate ? gate.refusal(table).reason : undefined;
  // …and refusing what runTarget's capability gates would refuse, so the preview never advertises a
  // route the run rejects (codex/cubic #76). Same pure decideCapabilities as runTarget (identical
  // inputs → identical grant), so plan and run can't disagree. Order mirrors runTarget: the capability
  // gate preempts the requiresWeb guard. TERMINAL capability refusals (unknown-token/operator-gate/
  // opt-in) always refuse → surfaced. `unenforceable` is NOT terminal — dispatch()'s capability-fit
  // fallback (~L712) may run it on a provider that CAN enforce — so it is deliberately NOT surfaced
  // here (that would advertise a refusal the run avoids); full fallback-modeled parity is HED-275.
  // Neither applies to an in-session Claude route: dispatch() returns the in-session instruction
  // (~L676) BEFORE runTarget's gates run, so surfacing one would diverge from the run (cubic #76). The
  // earlier gates (notDispatchable/override/same-provider/metered/no-account) are preempted by summarizePlan's chain.
  const reachesRunTarget = execution !== 'in-session-subagent';
  const dryReqCaps = [...new Set([...(target.capabilities ?? []), ...(req.capabilities ?? [])])];
  const dryCaps = decideCapabilities(target.provider, dryReqCaps, req.optIn === true, capabilityPolicy(table));
  const capabilityRefusal = reachesRunTarget && dryCaps.refusal && dryCaps.refusal.kind !== 'unenforceable' ? dryCaps.refusal.reason : undefined;
  const requiresWebRefusal = reachesRunTarget && !dryCaps.refusal && route.requiresWeb && !webCapable(target.provider, dryCaps.granted)
    ? webRefusalReason(route.taskClass, target.provider)
    : undefined;
  return { route, target, fallback, origin, execution, decision, skillsForRefusal, account, accountAdvice, accountPick, rotationAccount, claudeAccountCount, notDispatchable, reviewerPick, sameProviderReview, pinnedExcludedAccount, overrideReasonRequired, billingRefusal, billingAdvice, capabilityRefusal, requiresWebRefusal };
}

/** One shared dry-run summary for `heddle route` and the `plan_dispatch` MCP tool (identical fields). */
export function summarizePlan(plan: DispatchPlan): Record<string, unknown> {
  const notDispatchable = plan.notDispatchable;
  const noDispatchableAccount = hasNoDispatchableClaudeAccount(plan);
  return {
    task_class: plan.route.taskClass,
    would_run: notDispatchable || plan.decision.refusal || plan.billingRefusal || plan.sameProviderReview || plan.pinnedExcludedAccount || noDispatchableAccount || plan.overrideReasonRequired || plan.capabilityRefusal || plan.requiresWebRefusal ? null : `${plan.target.provider}/${plan.target.model}`,
    execution: plan.execution ?? null,
    in_session: plan.execution === 'in-session-subagent',
    routed_away_for_cap: plan.decision.routedAwayForCap,
    remaining_fallback: plan.fallback ? `${plan.fallback.provider}/${plan.fallback.model}` : null,
    route_reason: plan.decision.routeReason,
    refusal: notDispatchable
      ? { code: 'not-dispatchable', reason: `task class "${plan.route.taskClass}" is not dispatchable (dispatchable: false) — the orchestrator's own in-session work` }
      : plan.overrideReasonRequired
      ? { code: 'override-reason-required', reason: plan.overrideReasonRequired }
      : plan.sameProviderReview
      ? { code: 'same-provider-review', reason: plan.sameProviderReview }
      : plan.billingRefusal
      ? plan.billingRefusal
      : plan.decision.refusal
      ? plan.decision.refusal
      : plan.pinnedExcludedAccount
      ? { code: 'no-dispatchable-account', reason: plan.pinnedExcludedAccount.reason }
      : noDispatchableAccount
      ? { code: 'no-dispatchable-account', reason: noDispatchableClaudeAccountReason(plan.claudeAccountCount) }
      : plan.capabilityRefusal
      ? { code: 'capability-denied', reason: plan.capabilityRefusal }
      : plan.requiresWebRefusal
      ? { code: 'capability-denied', reason: plan.requiresWebRefusal }
      : null,
    checks: plan.decision.checks,
    account: plan.account,
    account_pick: plan.accountPick ? { id: plan.accountPick.account.id, used_pct: plan.accountPick.usedPct, reason: plan.accountPick.reason, config_dir: plan.accountPick.account.configDir } : null,
    account_advice: plan.accountAdvice?.line ?? null,
    billing_advice: plan.billingAdvice ?? null,
    reviewer_pick: plan.reviewerPick?.reason ?? null,
    would_refuse_same_provider: plan.sameProviderReview ?? null,
    skills: plan.skillsForRefusal,
  };
}
