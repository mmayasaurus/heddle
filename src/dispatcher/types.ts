/**
 * Dispatcher types — the request/refusal/outcome contract of dispatch(), the per-dispatch context
 * shared by the run and refusal paths, and the dry-run plan. Moved verbatim from src/dispatch.ts
 * (HED-282); dispatch.ts re-exports the public ones.
 */
import type { Ledger } from '../ledger.js';
import type { Route, RouteTarget, RoutingTable, StructuralCaps } from '../routing.js';
import type { ResultAssessment } from '../classify.js';
import type { ReviewerPick } from '../review.js';
import type { attributeDispatch, BoundIdentity } from '../identity.js';
import type { CapsByProvider } from '../usage.js';
import type { RouteDecision, ClaudeAccount, AccountAdvice, AccountPick } from '../capaware.js';
import type { RotationAccounts } from '../rotation.js';
import type { WorkerAdapter, WorkerResult } from '../types.js';

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
  /** Optional test/operator injection for the codex/cursor registry; absent reads accounts.json. */
  rotationAccounts?: RotationAccounts;
  /** Optional cooling-store path; absent is ~/.heddle/usage/cooling.json. */
  coolingPath?: string;
  /** Injected epoch seconds for deterministic account selection tests. */
  nowS?: number;
  /**
   * HED-95: WHY this dispatch routes around the routing table. Required on the DIRECT path
   * (provider+model with no task class) — benches, probes and judgment calls are all legitimate,
   * the point is that the reason lands in the ledger so HED-79's retune sees the real distribution
   * of why humans bypass the table (it previously saw only that they did).
   */
  overrideReason?: string;
  /** Required to run a task class marked requires_explicit_opt_in, and to grant `exec-privileged`. */
  optIn?: boolean;
  /** Skip the routing table's fallback on failure. */
  noFallback?: boolean;
  /** Capabilities to GRANT the worker (allowlist: net, browse, exec-privileged). Default: none. */
  capabilities?: string[];
  /** Process-bound identity; resolved from the environment when omitted (tests inject one). */
  identity?: BoundIdentity;
  /** Provider caps snapshot; read from ~/.heddle/usage when omitted (tests inject fixtures). */
  caps?: CapsByProvider;
  /** Claude account registry; read from ~/.heddle/accounts.json when omitted (tests inject). */
  accounts?: ClaudeAccount[];
  /**
   * Claude-primary classes: return the structured `claude-in-session` instruction (run it as your
   * own Agent-tool subagent, shared prompt cache + same account) instead of spawning a headless
   * `claude -p` worker on the account with the most headroom (HED-78 default).
   */
  inSession?: boolean;
  /** Force a specific registry account id for a headless Claude worker (else: most 5h headroom). */
  accountPin?: string;
  /**
   * HED-3 (adversarial-review): the provider that AUTHORED the change under review — the reviewer
   * must be a different provider (the class's reviewer_pool supplies the alternative); recorded on
   * the review row so reviewer pairs can be scored.
   */
  authorProvider?: string;
  /** HED-3: the model that authored the change, if known (recorded on the review row). */
  authorModel?: string;
  /** HED-3: the ledger id of the dispatch that produced the change (lineage), if any. */
  authorDispatchId?: number;
  /** HED-3: a git ref; heddle prepends "review `git diff <ref>...HEAD`" to the prompt. */
  diffBase?: string;
}

/**
 * heddle declined to run the dispatch itself — no worker was spawned. Structured so an orchestrator
 * (or its hook) can act on the code instead of parsing prose; the same code is in the ledger's
 * `refusal` column.
 */
export interface DispatchRefusal {
  code: 'claude-in-session' | 'no-dispatchable-account' | 'not-dispatchable' | 'depth-1' | 'max-children' | 'capability-denied' | 'metered-pool-exhausted' | 'same-provider-review' | 'override-reason-required' | 'fleet-paused';
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
  /**
   * HED-98 worktree confinement. Set when the worker ran in a linked worktree AND the parent
   * checkout changed underneath it (`paths`), or when the check could not be made (`available:
   * false`). A dedicated field, NOT `error`: the work product may be perfectly good, and callers
   * that treat a non-empty `error` as failure would otherwise misread a warning as a failed run.
   */
  escape?: { available: boolean; parentRoot: string; paths: string[]; note: string };
  /**
   * HED-127: work that existed in the worker's OWN cwd before the dispatch and is gone after — the
   * signature of a working-tree reset. Like `escape`, a warning rather than a failure, and never
   * auto-reverted: heddle reports, the operator decides.
   */
  destroyed?: { paths: string[]; note: string };
  /** Why this route ran — the cap-aware decision, verbatim from the ledger's `route_reason` (HED-67). */
  routeReason?: string;
  /** Account the worker was billed to / advised (codex: CODEX_HOME basename; claude advisory: best acct id). */
  account?: string | null;
  /** HED-3: set for review classes — who authored, who reviewed, and whether the read-only mandate held. */
  review?: {
    authorProvider: string | null;
    reviewerProvider: string;
    reviewerModel: string;
    /** true = worktree untouched, false = the reviewer changed files (MANDATE VIOLATION), null = not a git repo. */
    mandateOk: boolean | null;
    reviewerPick?: string;
  };
  /** HED-3 (`auto_assess: true` classes): assess_result on the worker's output — done | needs-rework | needs-human. */
  assessment?: ResultAssessment;
  /** Set on capability-denied refusals: which check failed (`unenforceable` means a fallback may fit). */
  capabilityRefusalKind?: 'unknown-token' | 'operator-gate' | 'opt-in' | 'unenforceable';
}

/** Resolves a provider name to its adapter. Injectable into dispatch() so tests can run the full
 *  dispatch pipeline (routing → skills/MCP materialization → ledger) against a fake worker. */
export type AdapterFactory = (provider: string) => WorkerAdapter;

/** Everything a dispatch decided before any worker ran — shared by the run and refusal paths. */
export interface DispatchContext {
  table: RoutingTable;
  ledger: Ledger;
  adapterFor: AdapterFactory;
  identity: BoundIdentity;
  attribution: ReturnType<typeof attributeDispatch>;
  caps: StructuralCaps;
  /** Set once the cap-aware decision is made; recorded on every row of this dispatch. */
  routeReason?: string;
  account?: string | null;
  /** HED-78: the Claude account (env) a headless claude worker runs under. */
  claudeAccount?: AccountPick | null;
  /** Selected non-Claude account env, resolved with the route alongside Claude account selection. */
  rotationAccount?: { provider: 'codex' | 'cursor'; id: string; env: Record<string, string>; unset: string[]; reason: string } | null;
  /** HED-3: set for review classes. */
  review?: { authorProvider: string | null; authorModel: string | null; authorDispatchId: number | null; reviewerPick?: string };
}

export interface RefusalOpts {
  /** Outcome fields specific to this refusal path (execution, usedFallback, …). */
  extra?: Partial<DispatchOutcome>;
  /** A ledger row that already exists for this attempt (e.g. the max-children transactional row). */
  ledgerId?: number;
  fellBackFrom?: string | null;
  /** The EFFECTIVE capabilities that drove the refusal (class defaults ∪ req.capabilities). A
   *  capability/web refusal triggered by a CLASS-DEFAULT capability must not be ledgered as caller-only
   *  (Copilot #76); pass the unioned list so the audit trail shows what was actually asked. */
  capabilities?: string[];
}

/** Everything a dispatch decides BEFORE any ledger row or worker: route, policy, caps, accounts. */
export interface DispatchPlan {
  route: Route;
  /** What would run (already swapped to the fallback when the cap-aware decision routed away). */
  target: RouteTarget;
  /** The class fallback still available for a failure retry (undefined once consumed). */
  fallback?: RouteTarget;
  origin: InSessionOrigin;
  execution: string | undefined;
  decision: RouteDecision;
  skillsForRefusal: string[];
  /** Account the run bills to / is advised (see DispatchOutcome.account). */
  account: string | null;
  accountAdvice?: AccountAdvice;
  /** HED-78: the Claude account a headless worker will run on. `undefined` = in-session/non-Claude;
   *  `null` = a registry was consulted but none is addressable (or it has no entries). */
  accountPick?: AccountPick | null;
  rotationAccount?: DispatchContext['rotationAccount'];
  /** Number of registered Claude accounts consulted for the effective Claude target. */
  claudeAccountCount: number;
  /** True for a `dispatchable: false` class — dispatch() refuses before any route runs. */
  notDispatchable: boolean;
  /** HED-3: set when the class primary matched the author's provider and a pool entry was taken instead. */
  reviewerPick?: ReviewerPick | null;
  /** HED-3: the caller named the author's own provider as the explicit route — refused. */
  sameProviderReview?: string;
  /** A pinned account was freshly excluded from dispatch; dispatch() returns a structured refusal. */
  pinnedExcludedAccount?: { pin: string; reason: string };
  /** HED-95: set when a bare direct route would be refused for lacking an override_reason —
   *  so `heddle route` / `plan_dispatch` never claim a route the real dispatch would refuse. */
  overrideReasonRequired?: string;
  /** HED-239: set when a TERMINAL capability refusal (unknown-token/operator-gate/opt-in) would reject
   *  the target — mirrors runTarget's capability gate in the dry run (the `unenforceable` kind is left
   *  for HED-275 since it may capability-fit-fallback rather than refuse). */
  capabilityRefusal?: string;
  /** HED-239: set when a requiresWeb class's effective target can't web — the dry run mirrors the
   *  runtime guard so plan_dispatch never advertises a web-research route the real dispatch refuses. */
  requiresWebRefusal?: string;
}

/** How the in-session route was chosen — the refusal reason must not misstate the YAML policy. */
export type InSessionOrigin = 'direct' | 'class' | 'explicit' | 'fallback';
