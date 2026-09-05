import { listTaskClasses, resolveRoute, type RouteTarget, type RoutingTable } from '../routing.js';
import type { DispatchRequest, DispatchRefusal } from './types.js';

/**
 * HED-95 override gate, shared by dispatch() and planDispatch() so the DRY RUN cannot claim a route
 * is runnable that the real dispatch would refuse (PR #32: three reviewers — `heddle route` and
 * `plan_dispatch` previously reported a bare provider+model as would_run).
 *
 * Returns null when the request is fine: it carries a task class, or it is a direct route WITH a
 * stated reason.
 */
const NON_REASON_STOPLIST = new Set([
  'habit', 'proven', 'faster', 'fast', 'worked before', 'works', 'it works', 'default', 'usual',
  'preference', 'prefer', 'same as before', 'as usual', 'familiar',
]);

function overrideReasonCore(reason: string, provider: string, model: string): string {
  // Word-tokenize on any non-alphanumeric run. This drops punctuation ENTIRELY, so a stoplisted
  // cliché with trailing/embedded punctuation ("worked before.", "terra: worked before.") still
  // normalizes to the bare cliché instead of sneaking past the exact-match set (qodo/codeant/gitar/
  // codex). It also means NO dynamic RegExp built from caller-controlled provider/model, sidestepping
  // the ReDoS surface codacy flagged. Identity words (provider + the model's segments, length >= 2 so
  // a bare version digit like "5" never strips a real digit out of the reason) are removed first.
  const identity = new Set(
    [provider, ...model.split(/[^a-z0-9]+/i)]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2),
  );
  return reason
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !identity.has(w))
    .join(' ');
}

/** True when a direct-route override reason is only its identity or a non-justification cliché. */
export function isNonReason(reason: string, provider: string, model: string): boolean {
  const core = overrideReasonCore(reason, provider, model);
  return !core || NON_REASON_STOPLIST.has(core) || core.replace(/\s/g, '').length < 8;
}

export function overrideReasonGate(
  req: Pick<DispatchRequest, 'taskClass' | 'provider' | 'model' | 'skills' | 'mcp' | 'overrideReason'>,
): { taskClass: string; target: RouteTarget; refusal: (table: RoutingTable) => DispatchRefusal } | null {
  if (req.taskClass || !req.provider || !req.model) return null;
  const { provider, model } = req;
  const reason = req.overrideReason?.trim() ?? '';
  if (reason && !isNonReason(reason, provider, model)) return null;
  // The same task_class shape directRoute() produces, so bypass rows sort with every other direct
  // row instead of needing a special case in the retune query (PR #32, copilot).
  const taskClass = `direct:${provider}/${model}`;
  const target = { taskClass, provider, model, skills: req.skills, mcp: req.mcp } as unknown as RouteTarget;
  return {
    taskClass,
    target,
    refusal: (table: RoutingTable) => {
      // Only suggest a class the caller could actually dispatch BY NAME: a non-dispatchable class
      // (orchestration) or an opt-in-gated one (second-opinion-hard/kimi) would ITSELF be refused,
      // so naming it as "the alternative" just moves the refusal one hop (grok, HED-148 review).
      // resolveRoute is wrapped: the table is only minimally validated at load, so a single malformed
      // or excluded class must not crash the refusal itself while it scans for a match (qodo).
      const suggestable = listTaskClasses(table)
        .map((taskClass) => {
          try { return { taskClass, route: resolveRoute(table, taskClass) }; }
          catch (err) {
            // Don't crash the refusal on one malformed class (qodo), but don't hide WHY it failed
            // either (corgea) — log the diagnostic and skip only that class as a suggestion.
            process.stderr.write(`heddle: routing class '${taskClass}' failed to resolve while composing an override-reason refusal (${err instanceof Error ? err.message : String(err)}) — skipping it\n`);
            return null;
          }
        })
        .filter((x): x is { taskClass: string; route: ReturnType<typeof resolveRoute> } =>
          x !== null && x.route.dispatchable !== false && !x.route.requiresExplicitOptIn);
      const matches = suggestable
        .map(({ taskClass, route }) => {
          if (route.provider === provider && route.model === model) return { taskClass, kind: 'primary' as const };
          const fallback = route.fallback;
          if (fallback && fallback.provider === provider && fallback.model === model) return { taskClass, kind: 'fallback' as const };
          return null;
        })
        .filter((match): match is { taskClass: string; kind: 'primary' | 'fallback' } => match !== null)
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'primary' ? -1 : 1));
      const routeInstruction = matches.length
        ? matches.map(({ taskClass, kind }) =>
          `${provider}/${model} IS the ${kind} route of task class \`${taskClass}\` — dispatch by that class instead of naming the model.`,
        ).join(' ')
        : `Pass a task class instead (${suggestable.map((s) => s.taskClass).join(', ')}) — the table carries the policy: default skills/MCP, opt-in gates, fallbacks and cap-aware routing.`;
      const core = overrideReasonCore(reason, provider, model);
      const reasonMessage = !reason
        ? `a direct provider+model dispatch (${provider}/${model}) has no override reason and must say why it bypasses the routing table`
        : `a direct provider+model dispatch (${provider}/${model}) gave an override reason that reduces to '${core}' — that names the route or is a cliché, not a reason; say what about THIS task needs ${provider}/${model}`;
      return {
        code: 'override-reason-required' as const,
        reason: reasonMessage,
        // Field names differ per surface — name all three rather than assuming an MCP caller.
        instruction: `${routeInstruction} If bypassing IS the intent ` +
          `(a bench, a probe, a judgment call), say why and it runs: override_reason (MCP), ` +
          `--override-reason (CLI), overrideReason (JS API). The reason is recorded on the ledger row so ` +
          `routing can be tuned from evidence.`,
      };
    },
  };
}
