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
import type { Account } from '../accounts.js';
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
  /**
   * Opt-in (default off): when a failed leg leaves isolable newly-created paths, auto-commit ONLY
   * those paths so fallback can proceed. A tree with pre-existing local changes is never
   * auto-committed; isolation failure refuses the fallback.
   */
  fallbackWipCommit?: boolean;
  /**
   * Per-dispatch request to keep the worker CLI's own interactive permission prompts. Undefined =
   * the adapter's constructed default (heddle's headless workers keep skipping, so the fleet is
   * unchanged); `false` keeps the native prompts (omits --dangerously-skip-permissions); `true`
   * forces skipping. Honored by agy (gemini routes) and OpenCode; GLM/HTTP and claude ignore it.
   * Permission-PROMPT toggle ONLY — it never widens capability caps or refusal semantics, which
   * stay default-deny. NOTE: with `false`, a headless agy or OpenCode run has no interactive terminal
   * to answer prompts unless its consumer supplies an external permission path.
   */
  skipPermissions?: boolean;
  /** Capabilities to GRANT the worker (allowlist: net, browse, exec-privileged). Default: none. */
  capabilities?: string[];
  /** Process-bound identity; resolved from the environment when omitted (tests inject one). */
  identity?: BoundIdentity;
  /** Provider caps snapshot; read from ~/.heddle/usage when omitted (tests inject fixtures). */
  caps?: CapsByProvider;
  /** Claude account registry; read from ~/.heddle/accounts.json when omitted (tests inject). */
  accounts?: ClaudeAccount[];
  /** Full registry used by tier-symbol availability; tests may supply a synthetic registry. */
  accountRegistry?: Account[];
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
  /** Fresh external quota evidence required by routes with a hard `bounds` envelope. */
  boundedAdmission?: BoundedAdmission;
}

export interface BoundedAdmission {
  /** Idempotency key for one provider attempt; atomically unique in the ledger. */
  requestId: string;
  /** External FDL session whose 48-dispatch/2.4M-token caps are being reserved. */
  sessionId: string;
  /** Subscription account represented by the headroom snapshot. */
  account: string;
  /** Provider/account tokens remaining when observedAt was captured. */
  remainingTokens: number;
  /** ISO-8601 capture time. Missing, invalid, or stale evidence refuses closed. */
  observedAt: string;
}

/**
 * heddle declined to run the dispatch itself — no worker was spawned. Structured so an orchestrator
 * (or its hook) can act on the code instead of parsing prose; the same code is in the ledger's
 * `refusal` column.
 */
export interface DispatchRefusal {
  code: 'claude-in-session' | 'no-dispatchable-account' | 'not-dispatchable' | 'depth-1' | 'max-children' | 'capability-denied' | 'tier-read-only' | 'metered-pool-exhausted' | 'same-provider-review' | 'override-reason-required' | 'fleet-paused' | 'fallback-blocked-dirty-tree' | 'billing.pay-per-token' | 'billing.open-billing-at-cap' | 'billing.prepaid-exhausted' | 'headless-claude-review-unreliable' | 'env-repoint.missing-token' | 'env-repoint.insecure-secrets' | 'env-repoint.invalid-config' | 'bounded-input-oversize' | 'bounded-unsupported-bound' | 'bounded-headroom-unknown' | 'bounded-headroom-stale' | 'bounded-account-mismatch' | 'bounded-aggregate-exhausted' | 'bounded-forbidden-fallback' | 'bounded-forbidden-extra-request' | 'bounded-forbidden-tools' | 'bounded-duplicate-request';
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
  /**
   * HED-601: a read-only dispatch whose worker VIOLATED the mandate (changed the worktree).
   * The violation is a HARD failure (`ok` is false) and the worker output is QUARANTINED — WITHHELD from the
   * trusted `output` field (which is emptied) and held HERE instead (`quarantine.output` always carries the
   * findings in the returned outcome). The VIOLATION is durably recorded on the ledger row (ok=0,
   * MANDATE-VIOLATION `error`, and `reviews.mandate_ok=0` for review classes); the findings TEXT is
   * best-effort-persisted to the ledger output store (`outputs/<id>.md`, exactly as any worker output — a
   * persist failure is logged, not fatal). Adopting anything from a quarantined run is a DELIBERATE act —
   * read `quarantine.output` or the ledger record; nothing downstream may treat it as a trustworthy finding. A
   * dedicated field, NOT `error` (same discipline as `escape`/`destroyed`): the withheld findings need a typed
   * home and callers that key on a non-empty `error` as failure must not misread it.
   */
  quarantine?: { reason: 'mandate-violation'; note: string; output: string; ledgerId: number };
  /** HED-3 (`auto_assess: true` classes): assess_result on the worker's output — done | needs-rework | needs-human. Absent on a quarantined run (a mandate violation is never graded). */
  assessment?: ResultAssessment;
  /** Set on capability-denied refusals: which check failed (`unenforceable` means a fallback may fit). */
  capabilityRefusalKind?: 'unknown-token' | 'operator-gate' | 'opt-in' | 'unenforceable';
  /**
   * HED-395 loud-degrade-to-ALLOW: the billing gate could not classify the bound account for spend
   * (unregistered id, unreadable registry, or a stale bounded-prepaid caps row) and ALLOWED the run
   * rather than refuse or silently skip. `reason` is the machine-greppable `billing-degraded:<reason>`
   * note also written to the dispatch's ledger row — queryable/scored, never stderr-only.
   */
  billingDegraded?: { reason: string };
  /** Auditable hard-bound evidence for routes carrying a `bounds` envelope. */
  boundedReceipt?: BoundedDispatchReceipt;
}

export interface BoundedDispatchReceipt {
  version: 1;
  status: 'refused' | 'completed' | 'incomplete';
  requestId: string | null;
  sessionId: string | null;
  provider: string;
  model: string;
  account: string | null;
  repository: { commit: string | null; dirty: boolean | null };
  fingerprints: { adapter: string; route: string; lanes: string };
  enforcementSupport: Record<string, 'native' | 'preflight-conservative' | 'atomic-ledger' | 'local-stream-cap' | 'local-validation' | 'unsupported'>;
  refusedDimensions: string[];
  reservation: { inputTokens: number; generatedTokens: number; totalTokens: number } | null;
  rawUsage: unknown;
  normalizedUsage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    generatedTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  };
  times: { headroomObservedAt: string | null; admittedAt: string | null; completedAt: string | null };
  remoteOutcome: 'provider-confirmed-cancelled' | 'unknown' | null;
  /** Explicit first-pass gaps; never represented as enforced capabilities. */
  stubs: string[];
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
  /** The preference symbol that selected the concrete route, if any. */
  symbol?: string;
  account?: string | null;
  /** HED-395: the provider-caps snapshot (`req.caps ?? readProviderCaps()`), computed ONCE in
   *  dispatch() and threaded so runTarget's billing gate reads the SAME snapshot the fallback
   *  hard-guard uses — never a fresh per-attempt read. */
  providerCaps?: CapsByProvider;
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
  /** Preference symbol that selected `target`, when tier-symbol routing participated. */
  symbol?: string;
  /** Ordered preference/ladder narration for `heddle route` and the ledger. */
  resolutionWalk?: string[];
  /** The class fallback still available for a failure retry (undefined once consumed). */
  fallback?: RouteTarget;
  origin: InSessionOrigin;
  execution: string | undefined;
  decision: RouteDecision;
  skillsForRefusal: string[];
  /** Account the run bills to / is advised (see DispatchOutcome.account). */
  account: string | null;
  accountAdvice?: AccountAdvice;
  /** Money-safety refusal for the selected rich-registry account. */
  billingRefusal?: DispatchRefusal;
  /** HED-404: structural tier read-only refusal for the selected account — the plan-level mirror of
   *  billingRefusal (undefined for in-session previews; the in-session tier gate is HED-573). */
  tierRefusal?: DispatchRefusal;
  /** Env-repoint refusal for the selected Claude account, shared with runTarget. */
  envRepointRefusal?: DispatchRefusal;
  /** Non-blocking bounded-prepaid warning when dispatch will consume the prepaid buffer. */
  billingAdvice?: string;
  /** HED-78: the Claude account a headless worker will run on. `undefined` = in-session/non-Claude;
   *  `null` = a registry was consulted but none is addressable (or it has no entries). */
  accountPick?: AccountPick | null;
  rotationAccount?: DispatchContext['rotationAccount'];
  /** Number of registered Claude accounts consulted for the effective Claude target. */
  claudeAccountCount: number;
  /** How many of those are env-repoint accounts that are pin-only beside a native one (HED-698). */
  claudePinOnlyCount: number;
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
  /** HED-395 F1: the run would deny the PRIMARY on an unenforceable capability AND a capability-fit
   *  fallback is ELIGIBLE to rebind (dispatch.ts capabilityFitFallbackEligible) — this mirrors the
   *  runtime rebind conditions EXACTLY, not just "the primary is unenforceable and some fallback exists".
   *  dispatch()'s plan-level billing gate reads it to avoid preempting that safe fallback for a
   *  billing-refused primary (the run bills the REBOUND account), and summarizePlan reads it so the
   *  preview never advertises a billing refusal the rebinding run never makes (F7 parity). */
  capabilityFitRebinds?: boolean;
  /** HED-519: set when a HEADLESS claude opus/fable adversarial-review would be refused (empirically
   *  unreliable — json-mode is silent till completion, so it SIGKILLs at timeout with zero output).
   *  Computed in planDispatch so summarizePlan (preview) and dispatch() agree. Holds the reason string. */
  headlessClaudeReviewRefusal?: string;
}

/** How the in-session route was chosen — the refusal reason must not misstate the YAML policy. */
export type InSessionOrigin = 'direct' | 'class' | 'explicit' | 'fallback';
