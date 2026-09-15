/**
 * runTarget — one attempt against one route target: policy → capability gates → ledger row →
 * materialize → run → restore → confinement/mandate checks → finish. Moved verbatim from
 * src/dispatch.ts (HED-282).
 */
import { materializeAgentsMd, readPack, composePacks } from '../skillpacks.js';
import { materializeWorkerMcp, validateWorkerMcp, codexMcpFlags, claudeMcpConfigFile, webCapable } from '../mcp.js';
import { isInProcessHttpProvider, isOpenAICompatProvider, openAICompatInputTokenUpperBound, readSecretsEnvValue } from '../adapters/openai-compat.js';
import { assessResult, type ResultAssessment } from '../classify.js';
import { snapshotWorktree, sameSnapshot, diffInstruction, embeddedDiff, READ_ONLY_MANDATE } from '../review.js';
import { parentCheckoutOf, checkoutFingerprint, escapedPaths, destroyedWork } from '../worktree.js';
import { loadAccountRegistry } from '../accounts.js';
import { effectiveFences } from '../fences.js';
import { decideCapabilities, capabilityPolicy } from '../capabilities.js';
import { capAwarePolicy } from '../capaware.js';
import { WORKER_ENV } from '../identity.js';
import { providerExecution, type Route, type RouteTarget } from '../routing.js';
import type { WorkerAdapter, WorkerResult } from '../types.js';
import { packsFor, requestedPacks } from './packs.js';
import { baseRecord, refusalOutcome, refuseBilling, webRefusalReason } from './refusals.js';
import { billingVerdict } from './billing.js';
import { tierReadOnlyVerdict } from './tier-gate.js';
import type { DispatchContext, DispatchRequest, DispatchOutcome, DispatchRefusal } from './types.js';
import { validateEnvRepoint, type AccountEnvRepoint } from '../accounts.js';
import { redactSecrets } from '../redact.js';
import { createBoundedReceipt, finalizeBoundedResult, normalizedBoundedUsage } from '../bounded-dispatch.js';

export type EnvRepointResolution =
  | { kind: 'none' }
  | { kind: 'refuse'; refusal: DispatchRefusal }
  | { kind: 'ok'; envRepoint: { baseUrl: string; authToken: string; service: string; model?: string } };

type EnvRepointToken = { ok: true; token: string } | { ok: false; refusal: DispatchRefusal };

function readEnvRepointToken(readSecret: (ref: string) => string, envRepoint: AccountEnvRepoint): EnvRepointToken {
  let authToken: string;
  try {
    authToken = readSecret(envRepoint.authTokenRef);
  } catch (err) {
    return { ok: false, refusal: { code: 'env-repoint.insecure-secrets',
      reason: `env-repoint ${envRepoint.service}: refusing to read ${envRepoint.authTokenRef} — ${err instanceof Error ? err.message : String(err)}`,
      instruction: 'Fix ~/.heddle/secrets.env permissions (chmod 600; owner-only, no symlink) and retry.' } };
  }
  if (!authToken) {
    return { ok: false, refusal: { code: 'env-repoint.missing-token',
      reason: `env-repoint ${envRepoint.service}: ${envRepoint.authTokenRef} not found in ~/.heddle/secrets.env`,
      instruction: 'Add the referenced free-tier credential to ~/.heddle/secrets.env and retry.' } };
  }
  return { ok: true, token: authToken };
}

export function resolveEnvRepoint(
  account: { id?: string; envRepoint?: AccountEnvRepoint } | undefined,
  targetProvider: string,
  readSecret: (ref: string) => string = (ref) => readSecretsEnvValue(ref) ?? '',
): EnvRepointResolution {
  if (targetProvider !== 'claude' || account?.envRepoint === undefined) return { kind: 'none' };

  let envRepoint: AccountEnvRepoint;
  try {
    envRepoint = validateEnvRepoint(account.envRepoint, `account "${account.id ?? '?'}"`, '<request>');
  } catch {
    return {
      kind: 'refuse',
      refusal: {
        code: 'env-repoint.invalid-config',
        reason: 'env-repoint account is misconfigured — refusing (will not fall back to native Claude billing)',
        instruction: 'Fix the account envRepoint (baseUrl must be an http(s) URL; service and authTokenRef required).',
      },
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envRepoint.authTokenRef)) {
    return {
      kind: 'refuse',
      refusal: {
        code: 'env-repoint.invalid-config',
        reason: `env-repoint ${envRepoint.service}: authTokenRef is not a valid environment-variable name (expected ^[A-Za-z_][A-Za-z0-9_]*$) — refusing to avoid leaking a possible secret`,
        instruction: 'Set authTokenRef to the NAME of the variable in ~/.heddle/secrets.env, not the token value.',
      },
    };
  }
  const tokenResult = readEnvRepointToken(readSecret, envRepoint);
  if (!tokenResult.ok) return { kind: 'refuse', refusal: tokenResult.refusal };
  const authToken = tokenResult.token;
  return {
    kind: 'ok',
    envRepoint: {
      baseUrl: envRepoint.baseUrl,
      authToken,
      service: envRepoint.service,
      ...(envRepoint.model === undefined ? {} : { model: envRepoint.model }),
    },
  };
}

export async function runTarget(
  target: RouteTarget, req: DispatchRequest, ctx: DispatchContext, route: Route,
  fellBackFrom: string | null,
): Promise<DispatchOutcome> {
  // Caller's explicit list REPLACES the table default; bounded routes intentionally materialize no
  // packs so their one HTTP request remains tool-free and byte-predictable.
  // The mandatory governance pack(s) are unioned
  // into whichever applies (see skillpacks.ts) — the ledger records the result, so it is auditable.
  // Review classes: the class packs carry the find-only MANDATE — an explicit skills list may add
  // packs but can never drop them (same posture as the worker-role union). requestedPacks is the
  // single definition every dry-run/refusal path shares.
  const skills = route.bounds
    ? []
    : packsFor(target.provider, requestedPacks(route.reviewerPool, target.skills, req.skills), req.cwd);
  // mcp is a REQUIREMENT, not best-effort: validateWorkerMcp (below) THROWS if the resolved provider
  // has no attachment path. HED-249 reverses HED-205's graceful-degrade — an mcp-carrying class may
  // only resolve to mcp-attachable providers (a routing.v0.yaml CI invariant enforces this for
  // primary + fallback + every reviewer_pool entry), so a gemini-in-an-mcp-class is a config error
  // that fails LOUD here rather than silently reviewing without discovery tools (ledger 206).
  const mcp = req.mcp ?? target.mcp ?? [];

  // Class capabilities are defaults: callers can add to them, but never silently drop them. This is
  // resolved per TARGET because a fallback may declare a different default capability set.
  const requestedCapabilities = [...new Set([...(target.capabilities ?? []), ...(req.capabilities ?? [])])];
  const caps = decideCapabilities(target.provider, requestedCapabilities, req.optIn === true, capabilityPolicy(ctx.table));
  if (caps.refusal) {
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: caps.refusal.code, reason: caps.refusal.reason,
      instruction: caps.refusal.kind === 'unenforceable'
        ? 'Dispatch to a provider that can enforce it (class + explicit provider/model), or drop the capability (see docs/MODELS.md "Capabilities").'
        : 'Drop the capability, or fix the call (see docs/MODELS.md "Capabilities").',
    }, { extra: { usedFallback: fellBackFrom !== null, capabilityRefusalKind: caps.refusal.kind }, fellBackFrom, capabilities: requestedCapabilities });
  }
  if (route.requiresWeb && !webCapable(target.provider, caps.granted)) {
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: 'capability-denied',
      reason: webRefusalReason(route.taskClass, target.provider),
      instruction: 'Use the class route, or select a provider with an enforceable browse grant.',
    }, { extra: { usedFallback: fellBackFrom !== null }, fellBackFrom, capabilities: requestedCapabilities });
  }

  // ---- Dispatch gate (HED-395): money-safety, evaluated BEFORE the ledger row and the spawn --------
  // The AUTHORITATIVE billing/overage decision, keyed on the FINAL bound account for THIS attempt
  // (ctx.account + target.provider), via the SAME billingVerdict the dry-run preview uses (F7 parity)
  // and the caps snapshot threaded once through ctx (never a fresh per-attempt read). Because EVERY
  // spawn path (primary, capability-fit fallback, account-failover, class fallback) enters here with
  // ctx.account rebound, gating HERE covers all of them — the removed plan-level gate only knew the
  // primary account. An extensible ordered sequence of typed checks: the FIRST veto wins and returns
  // BEFORE startUnderCap, so a refusal consumes no max-children slot (mirroring the capability/web
  // refusals just above). Billing runs FIRST; HED-404 (tier read-only) slots its check in after.
  // Placed AFTER the capability/web gates deliberately: a pay-per-token primary that ALSO can't enforce
  // a capability must return capability-denied so dispatch()'s capability-fit fallback runs — and that
  // fallback's account then gets its own billing check here in turn.
  const billing = billingVerdict({
    accountId: ctx.account ?? null,
    provider: target.provider,
    caps: ctx.providerCaps?.[target.provider],
    permitPayPerToken: capAwarePolicy(ctx.table).permitPayPerToken,
    table: ctx.table,
  });
  const tierGate = tierReadOnlyVerdict({
    accountId: ctx.account ?? null,
    provider: target.provider,
    readOnly: route.readOnly,
  });
  const gateChecks: Array<() => DispatchRefusal | null> = [
    () => billing.refusal ?? null, // HED-395 billing/overage — money-safety, first
    () => tierGate.refusal ?? null, // HED-404 structural read-only tier eligibility — after billing
  ];
  for (const check of gateChecks) {
    const veto = check();
    if (veto) return refuseBilling(ctx, req, route.taskClass, target, skills, veto, fellBackFrom);
  }
  // Env-repoint is resolved at the shared plan/run chokepoint. The pure worker-env builder receives
  // only resolved values, never a secret reference and never process.env credentials.
  const envRepointResolution = resolveEnvRepoint(ctx.claudeAccount?.account, target.provider);
  if (envRepointResolution.kind === 'refuse') {
    return refuseBilling(ctx, req, route.taskClass, target, skills, envRepointResolution.refusal, fellBackFrom);
  }
  const envRepoint = envRepointResolution.kind === 'ok' ? envRepointResolution.envRepoint : undefined;
  // Loud-degrade-to-ALLOW (F2/F4/F6): the gate could not classify the account for spend but must NOT
  // silently skip — warn now, and carry the machine-greppable note onto the ledger row (finish, below)
  // AND the outcome, so it is queryable/scored, never stderr-only.
  let billingDegraded: DispatchOutcome['billingDegraded'];
  if (billing.degraded) {
    billingDegraded = { reason: billing.degraded.note };
    process.stderr.write(`heddle: ${billing.degraded.warn}\n`);
  }

  // HED-19: fail fast, BEFORE a ledger row exists, on anything materialization would reject —
  // an unknown pack, an unknown/unsupported MCP attachment, an unknown provider. Nothing is
  // written and nothing is left in flight.
  for (const p of skills) readPack(p);
  validateWorkerMcp(target.provider, mcp);
  // Bounded HTTP dispatches are structurally fenced: a tool-less single-response call cannot write,
  // which is positive enforcement stronger than a mandate. Other routes retain HED-404's account gate.
  // HED-404: only a bound native account whose harness positively enforces read-only may be
  // recorded as fenced. Every resolution error or mismatch degrades to the explicit mandate.
  const fence = (() => {
    if (route.readOnly && route.bounds && isInProcessHttpProvider(target.provider)) return 'fenced';
    if (!route.readOnly) return undefined;
    try {
      const account = ctx.account === null ? undefined
        : loadAccountRegistry().accounts.find((a) => a.provider === target.provider && a.id === ctx.account);
      return effectiveFences(account?.harness ?? '', account?.fences).readOnlyEnforceable ? 'fenced' : 'mandate-only';
    } catch {
      return 'mandate-only';
    }
  })();
  const mandateOnly = fence === 'mandate-only';

  const isHttp = isInProcessHttpProvider(target.provider);
  const boundedReceipt = route.bounds
    ? createBoundedReceipt(route, target, req, ctx.table, 'incomplete')
    : undefined;
  const boundedSystemPromptAppend = route.bounds && isHttp && skills.length ? composePacks(skills) : undefined;
  const boundedPrompt = route.bounds
    ? (req.diffBase ? embeddedDiff(req.cwd, req.diffBase, undefined, false) + req.prompt : req.prompt)
    : undefined;
  let started;
  if (route.bounds && boundedReceipt && req.boundedAdmission && boundedPrompt !== undefined) {
    if (!isOpenAICompatProvider(target.provider)) {
      throw new Error(`bounded dispatch invariant: ${target.provider} passed preflight without OpenAI-compatible enforcement`);
    }
    const inputTokens = openAICompatInputTokenUpperBound(target.provider, boundedPrompt, {
      model: target.model,
      cwd: req.cwd,
      systemPromptAppend: boundedSystemPromptAppend,
      maxOutputTokens: route.bounds.maxGeneratedTokens,
      maxModelRequests: route.bounds.maxModelRequests,
      allowReasoningRetry: route.bounds.retry,
      timeoutMs: Math.min(req.timeoutMs ?? route.bounds.timeoutMs, route.bounds.timeoutMs),
    });
    boundedReceipt.reservation = {
      inputTokens,
      generatedTokens: route.bounds.maxGeneratedTokens,
      totalTokens: inputTokens + route.bounds.maxGeneratedTokens,
    };
    started = ctx.ledger.startBoundedUnderCap(
      baseRecord(ctx, req, route.taskClass, target, skills, fellBackFrom, caps.granted, fence),
      ctx.caps,
      { ...req.boundedAdmission, inputTokens },
      route.bounds,
    );
    if (!started.refused) boundedReceipt.times.admittedAt = started.admittedAt;
  } else {
    // Legacy max-children behavior is untouched when the route declares no resource envelope.
    started = ctx.ledger.startUnderCap(
      baseRecord(ctx, req, route.taskClass, target, skills, fellBackFrom, caps.granted, fence), ctx.caps,
    );
  }
  if (started.refused) {
    const refusalCode = ('code' in started ? started.code : 'max-children') as DispatchRefusal['code'];
    if (boundedReceipt) {
      boundedReceipt.status = 'refused';
      boundedReceipt.refusedDimensions = [
        refusalCode === 'bounded-input-oversize' ? 'inputTokens' :
          refusalCode === 'max-children' ? 'concurrency' :
            refusalCode === 'bounded-duplicate-request' ? 'duplicateRequest' :
              refusalCode === 'bounded-headroom-stale' ? 'accountHeadroom' : 'aggregateBudget',
      ];
      boundedReceipt.times.completedAt = new Date().toISOString();
    }
    return refusalOutcome(ctx, req, route.taskClass, target, skills, {
      code: refusalCode, reason: started.reason,
      instruction: refusalCode === 'max-children'
        ? 'Wait for a worker to finish (check_workers), or close orphaned rows.'
        : 'Refresh quota headroom or start a new external session only when its declared cap permits the complete reservation.',
    }, { extra: { usedFallback: fellBackFrom !== null, ...(boundedReceipt ? { boundedReceipt } : {}) }, ledgerId: started.id });
  }
  const ledgerId = started.id;
  // Adapter construction stays BELOW admission on purpose: a bounded route must refuse
  // (oversize input, exhausted headroom) before any provider factory runs (HED-570 invariant,
  // proven by test/bounded-dispatch.test.ts). Nothing above this line uses the adapter.
  let adapter: WorkerAdapter;
  try {
    adapter = ctx.adapterFor(target.provider);
    // HED-3: review rows carry the author→reviewer pair from the moment the row exists.
    if (ctx.review) {
      ctx.ledger.recordReview({
        dispatchId: ledgerId, authorProvider: ctx.review.authorProvider, authorModel: ctx.review.authorModel,
        authorDispatchId: ctx.review.authorDispatchId, reviewerProvider: target.provider, reviewerModel: target.model,
      });
    }
  } catch (err) {
    const error = `post-admission failure: ${err instanceof Error ? err.message : String(err)}`;
    if (route.bounds) {
      try { ctx.ledger.settleBoundedReservation(ledgerId, { inputTokens: null, generatedTokens: null }); } catch { /* finish must still run */ }
    }
    try {
      ctx.ledger.finish(ledgerId, { ok: false, error, output: '' });
    } catch { /* the attempted finish must not rethrow past this admitted path */ }
    return {
      ok: false, output: '', exitCode: null, error,
      taskClass: route.taskClass, provider: target.provider, model: target.model, skills,
      capabilities: caps.granted, ledgerId, usedFallback: fellBackFrom !== null,
      orchestrator: ctx.attribution.orchestrator, identitySource: ctx.attribution.identitySource,
      execution: providerExecution(ctx.table, target.provider), routeReason: ctx.routeReason,
      account: ctx.account ?? null,
      ...(boundedReceipt ? { boundedReceipt } : {}),
    };
  }
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
  // Claude workers (HED-78) get their packs via --append-system-prompt and MCP via a temp
  // --mcp-config file — nothing is written into the worktree — and run under the chosen account's
  // CLAUDE_CONFIG_DIR (unset for the default login).
  const isClaude = target.provider === 'claude';
  const acct = isClaude ? ctx.claudeAccount ?? null : null;
  const rotation = (target.provider === 'codex' || target.provider === 'cursor') ? ctx.rotationAccount ?? null : null;
  let restoreSkills: () => void = () => {};
  let restoreMcp: () => void = () => {};
  let before: ReturnType<typeof snapshotWorktree> | null = null;
  let after: ReturnType<typeof snapshotWorktree> | null = null;
  // HED-98: workers dispatched into <repo>/.worktrees/<agent> can resolve "the project root" by
  // walking up (a linked worktree's .git is a FILE pointing at the parent) and write into the
  // CANONICAL checkout. No provider offers a verified write-confinement flag, so heddle DETECTS:
  // fingerprint the parent checkout around the run and name whatever changed.
  const wt = parentCheckoutOf(req.cwd);
  const parentBefore = wt ? checkoutFingerprint(wt.parentRoot) : null;
  // HED-127: the worker's OWN cwd, to catch it discarding pre-existing uncommitted work.
  const cwdBefore = checkoutFingerprint(req.cwd);
  let destroyedReport: DispatchOutcome['destroyed'];
  let escapeReport: DispatchOutcome['escape'];
  let result: WorkerResult;
  try {
    let systemPromptAppend: string | undefined;
    let mcpConfigPath: string | undefined;
    if (isClaude) {
      const discovery = mcp.includes('memtrace')
        ? '\n\n---\n\nMemtrace MCP is attached: for code discovery use find_symbol / find_code FIRST ' +
          '(graph + semantic search), get_impact before changing a symbol — never blind-grep the tree. ' +
          'A zero-hit is not proof of absence; broaden the query.'
        : '';
      const packText = skills.length ? composePacks(skills) : '';
      systemPromptAppend = (packText + discovery) || undefined;
      const mcpFile = claudeMcpConfigFile(mcp); // always a file (possibly empty) → --strict-mcp-config
      mcpConfigPath = mcpFile.path; restoreMcp = mcpFile.cleanup;
    } else if (isHttp) {
      // HTTP/in-process providers have no filesystem: embed packs as their system prompt. MCP is
      // empty here because validateWorkerMcp rejects every non-empty HTTP-provider attachment.
      systemPromptAppend = boundedSystemPromptAppend ?? (skills.length ? composePacks(skills) : undefined);
    } else {
      // Per-dispatch blocks + liveness GC (HED-56): concurrent dispatches into one cwd each own
      // their block/ref; blocks left by crashed dispatches are collected on the next dispatch.
      // The oracle answers from THIS process's ledger with the concurrency-cap stale window —
      // a crashed process's forever-unfinished row reads dead after that window. Domain
      // assumption (documented): every dispatcher targeting one cwd shares the default ledger;
      // split-ledger fleets into one worktree are outside the supported model.
      const matOpts = { dispatchId: ledgerId, isLive: (id: string) => ctx.ledger.isInFlight(Number(id), ctx.caps.staleAfterMs) };
      restoreSkills = materializeAgentsMd(req.cwd, skills, matOpts);
      restoreMcp = materializeWorkerMcp(req.cwd, target.provider, mcp, matOpts);
    }
    // The mandate baseline is taken AFTER materialization and compared BEFORE restore (in finally):
    // injected files are part of the baseline, so a reviewer that edits AGENTS.md/.mcp.json is
    // caught — with the old before-materialize/after-restore ordering, restore MASKED those edits.
    // Detect escapes for EVERY read-only dispatch, not only the mandate-only path: a claude `--tools`
    // fence is not a complete worktree fence (MCP is attached via --strict-mcp-config, outside --tools),
    // so a "fenced" worker can still write — keep the belt-and-suspenders snapshot. (HED-404 r2.)
    before = route.readOnly ? snapshotWorktree(req.cwd) : null;
    // HTTP providers cannot run git; Claude read-only reviewers also receive an embedded diff because
    // their tool set has no Bash. Tool-less HTTP prompts must not mention Read/Grep/Glob.
    const embedDiff = (isClaude && route.readOnly) || isHttp;
    const mandate = mandateOnly ? `${READ_ONLY_MANDATE}\n\n` : '';
    // Bounded routes use the admission-time prompt VERBATIM: it was diff-embedded and
    // byte-counted for the input reservation upstream, and bounded targets are tool-less
    // single-response HTTP where a read-only mandate has nothing to govern — any
    // post-admission addition would silently break the reserved input bound.
    const mandatedPrompt = boundedPrompt ?? (req.diffBase
      ? (embedDiff ? embeddedDiff(req.cwd, req.diffBase, undefined, !isHttp) : diffInstruction(req.diffBase)) + mandate + req.prompt
      : mandate + req.prompt);
    // Best-effort PREVENTION to pair with the detection above: state the boundary explicitly, since
    // a worker that walks up to find "the project root" lands in the parent checkout and has no
    // other way to know it is inside a linked worktree.
    const prompt = wt && !isHttp
      ? `Your project root is the git WORKTREE ${wt.worktreeRoot} (your working directory is ` +
        `${req.cwd}). Create and edit files ONLY under that worktree. Do NOT walk up to ` +
        `${wt.parentRoot} — that is a different checkout shared with other agents, and writing ` +
        `there corrupts their work.\n\n${mandatedPrompt}`
      : mandatedPrompt;
    result = await adapter.dispatch(prompt, {
      model: target.model,
      cwd: req.cwd,
      effort: req.effort ?? target.effort,
      extraFlags,
      timeoutMs: route.bounds
        ? Math.min(req.timeoutMs ?? route.bounds.timeoutMs, route.bounds.timeoutMs)
        : req.timeoutMs,
      resume: req.resume,
      env: { ...req.env, ...acct?.env, ...rotation?.env, ...stamps },
      envRepoint: envRepoint && { ...envRepoint, authToken: envRepoint.authToken! },
      envUnset: [...(acct?.envUnset ?? []), ...(rotation?.unset ?? [])],
      capabilities: caps.granted,
      systemPromptAppend,
      mcpConfigPath,
      readOnly: route.readOnly,
      skipPermissions: req.skipPermissions,
      mcpServers: isClaude ? mcp : undefined,
      maxOutputTokens: route.bounds?.maxGeneratedTokens,
      maxOutputBytes: route.bounds?.maxOutputBytes,
      maxModelRequests: route.bounds?.maxModelRequests,
      allowReasoningRetry: route.bounds ? route.bounds.retry : undefined,
    });
  } catch (err) {
    result = { ok: false, output: '', exitCode: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (before) after = snapshotWorktree(req.cwd); // BEFORE restore — see the baseline comment above
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

  if (result.error) result.error = redactSecrets(result.error);

  // HED-98 worktree confinement: did anything change in the PARENT checkout while this worker ran?
  // Reported as a WARNING, not a failure: the work product may be perfectly good and destroying it
  // would be its own harm — but the side effects are dangerous and must never be silent. Nothing is
  // reverted (the operator decides, same discipline as the read-only mandate). heddle cannot ATTRIBUTE
  // the change — another agent legitimately editing the canonical checkout looks identical — so the
  // wording says what was observed, not who did it.
  if (wt) {
    const escaped = escapedPaths(parentBefore, checkoutFingerprint(wt.parentRoot));
    if (escaped === null) {
      const note = `escape-warning: worktree confinement could NOT be checked for ${wt.parentRoot} ` +
        `(its state was unreadable) — this run is unverified, not proven clean`;
      escapeReport = { available: false, parentRoot: wt.parentRoot, paths: [], note };
      process.stderr.write(`heddle: ${note}\n`);
    } else if (escaped.length) {
      const note = `escape-warning: the parent checkout ${wt.parentRoot} changed while this worker ran in ` +
        `${wt.worktreeRoot} — ${escaped.length} change(s): ${escaped.slice(0, 10).join(', ')}` +
        (escaped.length > 10 ? `, +${escaped.length - 10} more` : '') +
        ` (heddle cannot attribute the change; if it was this worker it escaped its sandbox — HED-98)`;
      escapeReport = { available: true, parentRoot: wt.parentRoot, paths: escaped, note };
      process.stderr.write(`heddle: ${note}\n`);
    }
  }

  // HED-127: did the worker discard work that was already in its cwd? Additions are the job and are
  // not reported; only losses are. Warning, not failure — the deliverable may be fine, and the
  // operator decides what to do about a tree that was reset under them.
  const lost = destroyedWork(cwdBefore, checkoutFingerprint(req.cwd));
  if (lost === null && cwdBefore !== null) {
    // The BEFORE read worked and the AFTER one did not: silence here would be indistinguishable
    // from "nothing was destroyed", which is the one thing a safety check must never imply
    // (PR #40, codacy + codex-connector). Mirrors the escape check's available:false.
    const note = `destroyed-work-warning: could NOT re-read ${req.cwd} after the dispatch — whether ` +
      `pre-existing work survived is UNVERIFIED, not proven intact`;
    destroyedReport = { paths: [], note };
    process.stderr.write(`heddle: ${note}\n`);
  } else if (lost && lost.length) {
    const note = `destroyed-work-warning: uncommitted work present in ${req.cwd} before this dispatch is ` +
      `gone — ${lost.length} item(s): ${lost.slice(0, 10).join(', ')}` +
      (lost.length > 10 ? `, +${lost.length - 10} more` : '') +
      ` (a worker must never reset the tree it was given — HED-127)`;
    destroyedReport = { paths: lost, note };
    process.stderr.write(`heddle: ${note}\n`);
  }

  // HED-3 / HED-601 read-only mandate: the worktree must be exactly as it was. A violation is recorded,
  // the dispatch HARD-fails (ok=0), and the reviewer's output is QUARANTINED (withheld from the trusted
  // `output` channel); nothing is reverted (operator's call).
  let mandateOk: boolean | null = null;
  let quarantine: DispatchOutcome['quarantine'];
  if (before && after) {
    mandateOk = sameSnapshot(before, after);
    if (ctx.review) ctx.ledger.setReviewMandate(ledgerId, mandateOk);
    if (mandateOk === false) {
      // HED-601: a reviewer that changed the worktree did NOT do the job it was given —
      // a read-only MANDATE VIOLATION is a HARD failure whose output is QUARANTINED, never auto-trusted.
      // The findings are WITHHELD from the trusted `output` channel (emptied in the returned outcome below)
      // and moved to `quarantine`; the ledger row keeps them (output persisted to outputs/<id>.md, ok=0) as
      // the durable record, so adopting any finding is a deliberate act on it. Nothing is reverted.
      const note = `MANDATE VIOLATION: the read-only worker changed the worktree (content digest of HEAD + tracked/untracked files + stash differs from before the run) — nothing was reverted; the worker output is QUARANTINED (dispatch ok=0), never auto-trusted. The violation is durably recorded on the ledger row (ok=0 + this error, plus mandate_ok=0 on review rows); the findings ride this outcome's quarantine.output and are best-effort-persisted to the ledger output store (outputs/${ledgerId}.md when the write succeeds). Inspect \`git status\`/\`git diff\`, then adopt any finding only as a deliberate act on that quarantine record.`;
      process.stderr.write(`heddle: ${note}\n`);
      result.ok = false;
      result.error = result.error ? `${result.error}; ${note}` : note;
      quarantine = { reason: 'mandate-violation', note, output: result.output ?? '', ledgerId };
    }
  }
  // HED-3 auto-assess: judge the reviewer's output with the cheap classifier (best-effort).
  // HED-601: never grade QUARANTINED output — a mandate-violating worker did not do its task, so assessing it
  // would both re-surface it as a trustworthy result and spend a classifier on withheld findings.
  let assessment: ResultAssessment | undefined;
  if (route.autoAssess && result.output && !quarantine) {
    try { assessment = await assessResult(req.prompt, result.output, result.ok, req.cwd, ctx.ledger); } catch (err) {
      // Best-effort by design, but never SILENT: a classifier outage should be visible in the logs.
      process.stderr.write(`heddle: auto-assess failed (${err instanceof Error ? err.message : String(err)}) — outcome recorded without assessment\n`);
    }
  }

  try {
    if (route.bounds && boundedReceipt) {
      result = finalizeBoundedResult(result, boundedReceipt, route.bounds);
      const normalized = normalizedBoundedUsage(result.usage);
      ctx.ledger.settleBoundedReservation(ledgerId, {
        inputTokens: normalized.inputTokens,
        generatedTokens: normalized.generatedTokens,
      });
    }
  } catch (err) {
    // Only the settlement machinery failed — keep the provider's retained output/usage on the outcome
    // and the finish row rather than discarding a completed analysis over a ledger UPDATE error.
    result = { ...result, ok: false, error: `post-admission failure: ${err instanceof Error ? err.message : String(err)}` };
    if (route.bounds) {
      try { ctx.ledger.settleBoundedReservation(ledgerId, { inputTokens: null, generatedTokens: null }); } catch { /* finish must still run */ }
    }
  }

  try { ctx.ledger.finish(ledgerId, {
    ok: result.ok,
    // The escape note is appended to the LEDGER's error column so the row is durably self-describing
    // (the outcome keeps it in its own `escape` field, so callers never mistake it for a failure). The
    // HED-395 billing-degraded note rides the same column for the same reason (queryable, never silent).
    // result.error is already redacted at the line-337 boundary (the vendor-stderr credential vector).
    // The escape/destroyed-work notes and the billing reason are heddle-GENERATED safety/status strings
    // (they carry checkout FILENAMES, not vendor credentials) — they must NOT be re-redacted here, or an
    // ordinary long filename (24+ chars w/ digits, not '/'-anchored) would be scrubbed from the ledger's
    // own escape record. So the join is persisted verbatim; only result.error passed through redaction.
    // (A worker COULD name a parent-checkout file after its own credential, persisting that credential-
    // shaped FILENAME here; scrubbing heddle-generated safety notes without destroying ordinary filenames
    // is a separate concern from F6's vendor-error-output scope — tracked in HED-651.)
    error: [result.error, escapeReport?.note, destroyedReport?.note, billingDegraded?.reason].filter(Boolean).join('; ') || undefined,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    inputTokens: result.usage?.inputTokens,
    cachedInputTokens: result.usage?.cachedInputTokens,
    outputTokens: result.usage?.outputTokens,
    reasoningTokens: result.usage?.reasoningOutputTokens,
    output: result.output,
  }); } catch (err) {
    // The row could not be finished; surface the failure but keep the worker's output with it.
    result = { ...result, ok: false, error: `post-admission failure: ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    ...result,
    // HED-601: a quarantined run withholds its findings from the trusted `output` channel — a caller must
    // reach into `quarantine` (a deliberate act) to see them; the ledger keeps the full record.
    ...(quarantine ? { output: '' } : {}),
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
    routeReason: ctx.routeReason,
    account: ctx.account ?? null,
    ...(escapeReport ? { escape: escapeReport } : {}),
    ...(destroyedReport ? { destroyed: destroyedReport } : {}),
    ...(billingDegraded ? { billingDegraded } : {}),
    ...(boundedReceipt ? { boundedReceipt } : {}),
    ...(ctx.review ? { review: { authorProvider: ctx.review.authorProvider, reviewerProvider: target.provider, reviewerModel: target.model, mandateOk, reviewerPick: ctx.review.reviewerPick } } : {}),
    ...(assessment ? { assessment } : {}),
    ...(quarantine ? { quarantine } : {}),
  };
}
