import { isCodeEditingClass, resolveRoute, type Route, type RoutingTable } from './routing.js';
import { MANDATORY_PACKS, withMandatoryPacks } from './skillpacks.js';

/**
 * Dispatch-time guidance — the pure logic behind the `dispatch_worker` PreToolUse hook
 * (src/hook-dispatch-guidance.ts) and reusable by anything else that wants to sanity-check a
 * dispatch request before it runs. It NEVER blocks: it returns warnings that surface fit + cost at
 * the moment an orchestrator chooses a worker (docs/MODELS.md "Dispatch-time surfacing"). Two
 * cases, both data-driven from the routing table, so a YAML change tunes them without a rebuild:
 *
 *  1. A code-editing class (`edits_code: true`) dispatched WITHOUT its task-fit packs: the class
 *     lists recommended packs (its `skills:` default minus the mandatory governance pack) and the
 *     dispatch carries NONE of them — an explicit `skills` list that dropped them all, e.g. `[]` or
 *     `['worker-role']` or an unrelated project pack — or the class lists none and the dispatch has
 *     no task-fit pack at all. Such a worker gets no quality-gate / discovery discipline, the
 *     failure mode the packs exist to prevent. Carrying at least one recommended pack is enough (a
 *     nudge, not a nag).
 *  2. A class that `requires_explicit_opt_in` (today: second-opinion-hard) dispatched without
 *     `opt_in: true`. The dispatcher will REFUSE it anyway; the warning explains the cost up front
 *     so the orchestrator picks knowingly instead of retrying blind.
 *
 * `provider`+`model` without a class → nothing here applies (the class path is where policy lives).
 * `provider`+`model` WITH a class → the class still supplies the policy (dispatch.ts), so the
 * warnings above apply unchanged.
 */

/** The subset of a `dispatch_worker` call the guidance looks at (MCP tool_input field names). */
export interface DispatchGuidanceInput {
  task_class?: string;
  provider?: string;
  model?: string;
  skills?: string[];
  opt_in?: boolean;
}

export type GuidanceCode = 'code-editing-class-without-skills' | 'opt-in-required';

export interface GuidanceWarning {
  code: GuidanceCode;
  task_class: string;
  message: string;
}

/**
 * Task-fit packs = everything the dispatch will materialize beyond the mandatory governance pack(s).
 * Mirrors the dispatcher: an explicit `skills` list replaces the table default; worker-role is
 * unioned in either way, so it is deliberately excluded from "does this dispatch carry any fit".
 */
export function taskFitPacks(table: RoutingTable, input: DispatchGuidanceInput): string[] {
  const route = input.task_class ? resolveRoute(table, input.task_class) : undefined;
  const effective = withMandatoryPacks(input.skills ?? route?.skills ?? []);
  return effective.filter((p) => !(MANDATORY_PACKS as readonly string[]).includes(p));
}

export function dispatchGuidance(table: RoutingTable, input: DispatchGuidanceInput): GuidanceWarning[] {
  const cls = input.task_class;
  if (!cls) return []; // direct provider/model path — no class policy to check
  // Own-property check: `"toString" in {}` is true via the prototype and would make resolveRoute throw.
  if (!Object.prototype.hasOwnProperty.call(table.taskClasses, cls)) return []; // unknown: the dispatcher will say so

  const route = resolveRoute(table, cls);
  const optInMissing = Boolean(route.requiresExplicitOptIn) && input.opt_in !== true;
  const warnings: GuidanceWarning[] = [];
  const fit = isCodeEditingClass(table, cls) ? codeEditingWarning(table, input, route, cls, optInMissing) : null;
  if (fit) warnings.push(fit);
  if (optInMissing) warnings.push(optInWarning(input, route, cls));
  return warnings;
}

/** Rule 1 — a code-editing class carrying none of its recommended packs. */
function codeEditingWarning(
  table: RoutingTable, input: DispatchGuidanceInput, route: Route, cls: string, optInMissing: boolean,
): GuidanceWarning | null {
  const defaults = withMandatoryPacks(route.skills ?? []);
  const recommended = defaults.filter((p) => !(MANDATORY_PACKS as readonly string[]).includes(p));
  const carried = taskFitPacks(table, input);
  const missingFit = recommended.length ? !recommended.some((p) => carried.includes(p)) : carried.length === 0;
  if (!missingFit) return null;
  const carriedText = carried.length
    ? `none of its recommended packs (only [${carried.join(', ')}] plus the mandatory ${MANDATORY_PACKS.join(', ')})`
    : `no task-fit skill packs — only the mandatory ${MANDATORY_PACKS.join(', ')}`;
  const adviceText = recommended.length
    ? `Recommended for ${cls}: ${recommended.join(', ')} — omit \`skills\` to get the class default ` +
      `[${defaults.join(', ')}], or pass an explicit list that includes at least one of them.`
    : `The routing table lists no default packs for ${cls} either — consider quality-gate ` +
      `(verification) and code-discovery (graph-first navigation), or add defaults to routing.v0.yaml.`;
  return {
    code: 'code-editing-class-without-skills',
    task_class: cls,
    message:
      `heddle: task class "${cls}" EDITS CODE but this dispatch carries ${carriedText}. The worker gets no ` +
      `verification / discovery discipline. ${adviceText}` +
      // Don't promise "will still run" when the opt-in warning says the opposite.
      (optInMissing ? '' : ' (Nudge only — the dispatch will still run.)'),
  };
}

/** Rule 2 — an opt-in-gated class called without opt_in (the dispatcher will refuse it). */
function optInWarning(input: DispatchGuidanceInput, route: Route, cls: string): GuidanceWarning {
  // With an explicit provider/model the dispatcher runs THAT route (class = policy), so describe it —
  // the class's own route/cost note would misstate what is about to happen.
  const explicit = input.provider && input.model ? `${input.provider}/${input.model}` : null;
  const classRoute = `${route.provider}/${route.model}`;
  const routeText = explicit
    ? `This call names the explicit route ${explicit} under the class's policy` +
      (explicit !== classRoute ? ` (the class's own route ${classRoute} will not run)` : '') + `. `
    : `Routes to ${classRoute}. `;
  return {
    code: 'opt-in-required',
    task_class: cls,
    message:
      `heddle: task class "${cls}" requires explicit opt-in and this call has no \`opt_in: true\` — ` +
      `the dispatcher WILL REFUSE it. Why the class is gated: ${route.note ?? 'see routing.v0.yaml'}. ` +
      routeText +
      `Pass \`opt_in: true\` only if the cost is justified (ask the operator first); otherwise pick a ` +
      `class that is not gated (see list_task_classes).`,
  };
}

/**
 * Claude Code PreToolUse hook response for a `dispatch_worker` call, or null when there is nothing
 * to say (the hook then exits silently and the normal permission flow applies). Contract
 * (code.claude.com/docs/en/hooks, verified 2026-08-15): `hookSpecificOutput.additionalContext` is
 * added to the model's context; top-level `systemMessage` is shown to the user. No
 * `permissionDecision` is set on purpose — this is a nudge, not a gate: it neither auto-allows the
 * call (which would skip the user's own permission flow) nor blocks it.
 */
export function hookResponse(payload: unknown, table: RoutingTable): string | null {
  const p = (payload ?? {}) as { tool_name?: unknown; tool_input?: unknown };
  const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
  // Matched by settings.json (`mcp__heddle__dispatch_worker`), but be defensive: any other tool → silent.
  if (!/(^|__)dispatch_worker$/.test(toolName)) return null;
  const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}) as DispatchGuidanceInput;
  const warnings = dispatchGuidance(table, input);
  if (warnings.length === 0) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: warnings.map((w) => w.message).join('\n'),
    },
    systemMessage: `heddle dispatch guidance: ${warnings.map((w) => `${w.code} (${w.task_class})`).join('; ')}`,
  });
}
