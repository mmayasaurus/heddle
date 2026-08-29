/**
 * runTarget — one attempt against one route target: policy → capability gates → ledger row →
 * materialize → run → restore → confinement/mandate checks → finish. Moved verbatim from
 * src/dispatch.ts (HED-282).
 */
import { materializeAgentsMd, readPack, composePacks } from '../skillpacks.js';
import { materializeWorkerMcp, validateWorkerMcp, codexMcpFlags, claudeMcpConfigFile, webCapable } from '../mcp.js';
import { assessResult, type ResultAssessment } from '../classify.js';
import { snapshotWorktree, sameSnapshot, diffInstruction, embeddedDiff } from '../review.js';
import { parentCheckoutOf, checkoutFingerprint, escapedPaths, destroyedWork } from '../worktree.js';
import { decideCapabilities, capabilityPolicy } from '../capabilities.js';
import { WORKER_ENV } from '../identity.js';
import { providerExecution, type Route, type RouteTarget } from '../routing.js';
import type { WorkerResult } from '../types.js';
import { packsFor, requestedPacks } from './packs.js';
import { baseRecord, refusalOutcome, webRefusalReason } from './refusals.js';
import type { DispatchContext, DispatchRequest, DispatchOutcome } from './types.js';

export async function runTarget(
  target: RouteTarget, req: DispatchRequest, ctx: DispatchContext, route: Route,
  fellBackFrom: string | null,
): Promise<DispatchOutcome> {
  // Caller's explicit list REPLACES the table default; the mandatory governance pack(s) are unioned
  // into whichever applies (see skillpacks.ts) — the ledger records the result, so it is auditable.
  // Review classes: the class packs carry the find-only MANDATE — an explicit skills list may add
  // packs but can never drop them (same posture as the worker-role union). requestedPacks is the
  // single definition every dry-run/refusal path shares.
  const skills = packsFor(target.provider, requestedPacks(route.reviewerPool, target.skills, req.skills), req.cwd);
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
  // HED-3: review rows carry the author→reviewer pair from the moment the row exists.
  if (ctx.review) {
    ctx.ledger.recordReview({
      dispatchId: ledgerId, authorProvider: ctx.review.authorProvider, authorModel: ctx.review.authorModel,
      authorDispatchId: ctx.review.authorDispatchId, reviewerProvider: target.provider, reviewerModel: target.model,
    });
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
    before = route.readOnly ? snapshotWorktree(req.cwd) : null;
    // diff_base delivery is PER TARGET: a claude read-only reviewer has no Bash (its --tools set),
    // so it gets the diff embedded; every other reviewer is told to run git itself.
    const basePrompt = req.diffBase
      ? (isClaude && route.readOnly ? embeddedDiff(req.cwd, req.diffBase) : diffInstruction(req.diffBase)) + req.prompt
      : req.prompt;
    // Best-effort PREVENTION to pair with the detection above: state the boundary explicitly, since
    // a worker that walks up to find "the project root" lands in the parent checkout and has no
    // other way to know it is inside a linked worktree.
    const prompt = wt
      ? `Your project root is the git WORKTREE ${wt.worktreeRoot} (your working directory is ` +
        `${req.cwd}). Create and edit files ONLY under that worktree. Do NOT walk up to ` +
        `${wt.parentRoot} — that is a different checkout shared with other agents, and writing ` +
        `there corrupts their work.\n\n${basePrompt}`
      : basePrompt;
    result = await adapter.dispatch(prompt, {
      model: target.model,
      cwd: req.cwd,
      effort: req.effort ?? target.effort,
      extraFlags,
      timeoutMs: req.timeoutMs,
      resume: req.resume,
      env: { ...req.env, ...acct?.env, ...rotation?.env, ...stamps },
      envUnset: [...(acct?.envUnset ?? []), ...(rotation?.unset ?? [])],
      capabilities: caps.granted,
      systemPromptAppend,
      mcpConfigPath,
      readOnly: route.readOnly,
      mcpServers: isClaude ? mcp : undefined,
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

  // HED-3 read-only mandate: the worktree must be exactly as it was. A violation is recorded and
  // surfaced — the reviewer's findings are still returned and nothing is reverted (operator's call).
  let mandateOk: boolean | null = null;
  if (before && after) {
    mandateOk = sameSnapshot(before, after);
    if (ctx.review) ctx.ledger.setReviewMandate(ledgerId, mandateOk);
    if (mandateOk === false) {
      // A reviewer that changed the worktree did NOT do the job it was given: the dispatch is not ok
      // (ledger ok=0), the findings are still returned, nothing is reverted (operator's call).
      const note = 'MANDATE VIOLATION: the read-only worker changed the worktree (content digest of HEAD + tracked/untracked files + stash differs from before the run) — inspect `git status`/`git diff` before trusting the findings; nothing was reverted';
      result.ok = false;
      result.error = result.error ? `${result.error}; ${note}` : note;
    }
  }
  // HED-3 auto-assess: judge the reviewer's output with the cheap classifier (best-effort).
  let assessment: ResultAssessment | undefined;
  if (route.autoAssess && result.output) {
    try { assessment = await assessResult(req.prompt, result.output, result.ok, req.cwd, ctx.ledger); } catch (err) {
      // Best-effort by design, but never SILENT: a classifier outage should be visible in the logs.
      process.stderr.write(`heddle: auto-assess failed (${err instanceof Error ? err.message : String(err)}) — outcome recorded without assessment\n`);
    }
  }

  ctx.ledger.finish(ledgerId, {
    ok: result.ok,
    // The escape note is appended to the LEDGER's error column so the row is durably self-describing
    // (the outcome keeps it in its own `escape` field, so callers never mistake it for a failure).
    error: [result.error, escapeReport?.note, destroyedReport?.note].filter(Boolean).join('; ') || undefined,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    inputTokens: result.usage?.inputTokens,
    cachedInputTokens: result.usage?.cachedInputTokens,
    outputTokens: result.usage?.outputTokens,
    reasoningTokens: result.usage?.reasoningOutputTokens,
    output: result.output,
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
    routeReason: ctx.routeReason,
    account: ctx.account ?? null,
    ...(escapeReport ? { escape: escapeReport } : {}),
    ...(destroyedReport ? { destroyed: destroyedReport } : {}),
    ...(ctx.review ? { review: { authorProvider: ctx.review.authorProvider, reviewerProvider: target.provider, reviewerModel: target.model, mandateOk, reviewerPick: ctx.review.reviewerPick } } : {}),
    ...(assessment ? { assessment } : {}),
  };
}
