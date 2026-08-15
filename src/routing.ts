import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Routing table loader — task class → provider/model/effort/skills, with fallbacks and the
 * subscription policy guards. The table is data, not code, so Maya can tune it without a rebuild.
 */

export interface RouteTarget {
  provider: string;
  model: string;
  effort?: string;
  extraFlags?: string[];
  skills?: string[];
  /** Code-discovery MCP servers to attach for this route (e.g. ["memtrace"]). */
  mcp?: string[];
  requiresExplicitOptIn?: boolean;
  note?: string;
}

export interface Route extends RouteTarget {
  taskClass: string;
  fallback?: RouteTarget;
  /** One-line "when to pick this class and why it routes there" (YAML `why:`). */
  why?: string;
  /**
   * True when workers of this class change files (YAML `edits_code:`). Drives the dispatch-guidance
   * hook's no-task-fit-packs nudge. Strictly the boolean `true` — anything else reads as false.
   */
  editsCode: boolean;
  /**
   * False when the class is the orchestrator's OWN work and is never delegated (YAML
   * `dispatchable: false`, today only `orchestration`): dispatching it is refused with an
   * instruction to continue in-session, and no delegated-worker pack is suggested. Default true.
   */
  dispatchable: boolean;
}

export interface RoutingTable {
  version: number;
  policy: Record<string, unknown>;
  providers: Record<string, Record<string, unknown>>;
  taskClasses: Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Repo-relative default; overridable via HEDDLE_ROUTING for experiments. */
export function defaultRoutingPath(): string {
  const envPath = process.env.HEDDLE_ROUTING;
  if (envPath) return envPath;
  // dist/ -> repo root -> routing/
  return join(here, '..', 'routing', 'routing.v0.yaml');
}

export function loadRouting(path = defaultRoutingPath()): RoutingTable {
  if (!existsSync(path)) throw new Error(`routing table not found: ${path}`);
  const raw = parseYaml(readFileSync(path, 'utf8')) as any;
  if (!raw?.task_classes) throw new Error(`routing table has no task_classes: ${path}`);
  return {
    version: raw.version ?? 0,
    policy: raw.policy ?? {},
    providers: raw.providers ?? {},
    taskClasses: raw.task_classes,
  };
}

/** A YAML list field must be a list: `skills: quality-gate` (a bare string) would otherwise spread
 *  into characters downstream and read as "has packs". Loud beats silent for a policy file. */
function listField(node: any, key: string, where: string): string[] | undefined {
  const v = node[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  throw new Error(`routing table: ${where}.${key} must be a list of strings (got ${JSON.stringify(v)})`);
}

function toTarget(node: any, where = 'task class'): RouteTarget | undefined {
  if (!node) return undefined;
  return {
    provider: node.provider,
    model: node.model,
    effort: node.effort,
    // Provider-specific flag keys stay explicit rather than magic: codex_flags today.
    extraFlags: node.codex_flags ?? node.extra_flags,
    skills: listField(node, 'skills', where),
    mcp: listField(node, 'mcp', where),
    requiresExplicitOptIn: node.requires_explicit_opt_in === true,
    note: node.note,
  };
}

export function resolveRoute(table: RoutingTable, taskClass: string): Route {
  const node = (table.taskClasses as any)[taskClass];
  if (!node) {
    const known = Object.keys(table.taskClasses).join(', ');
    throw new Error(`unknown task class "${taskClass}". Known classes: ${known}`);
  }
  const primary = toTarget(node, `task_classes.${taskClass}`)!;
  if (!primary.provider || !primary.model) {
    throw new Error(`task class "${taskClass}" is missing provider or model`);
  }
  const providerCfg = table.providers[primary.provider];
  if (providerCfg?.status === 'excluded') {
    throw new Error(`task class "${taskClass}" routes to excluded provider "${primary.provider}"`);
  }
  // The fallback is a different ROUTE for the same CLASS, so class-level policy (skill packs, MCP
  // servers) carries over unless the fallback node sets its own. Effort deliberately does not: its
  // vocabulary is per provider (codex minimal…xhigh vs agy low|medium|high; cursor bakes it into
  // the model id), so a primary's effort would be wrong or rejected on another provider.
  const fb = toTarget(node.fallback, `task_classes.${taskClass}.fallback`);
  if (fb) {
    if (!fb.provider || !fb.model) {
      throw new Error(`task class "${taskClass}": fallback is missing provider or model`);
    }
    // Same policy checks as the primary: a fallback into an unknown/excluded provider is a broken
    // table, surfaced at resolve time — not after the primary already failed.
    const fbCfg = table.providers[fb.provider];
    if (!fbCfg) throw new Error(`task class "${taskClass}": fallback names unknown provider "${fb.provider}"`);
    if (fbCfg.status === 'excluded') {
      throw new Error(`task class "${taskClass}": fallback routes to excluded provider "${fb.provider}"`);
    }
  }
  const fallback = fb ? { ...fb, skills: fb.skills ?? primary.skills, mcp: fb.mcp ?? primary.mcp } : undefined;
  return {
    taskClass,
    ...primary,
    fallback,
    why: typeof node.why === 'string' ? node.why : undefined,
    editsCode: node.edits_code === true,
    dispatchable: node.dispatchable !== false,
  };
}

/** Structural caps (HED-2) — from `policy.structural_caps` in the routing YAML, with defaults. */
export interface StructuralCaps {
  /** Max workers one orchestrator may have in flight at once. */
  max: number;
  /** In-flight rows older than this are treated as orphaned and do not hold a slot. */
  staleAfterMs: number;
}
export const DEFAULT_STRUCTURAL_CAPS: StructuralCaps = { max: 8, staleAfterMs: 3 * 60 * 60 * 1000 };

export function structuralCaps(table: RoutingTable): StructuralCaps {
  const node = (table.policy as any)?.structural_caps ?? {};
  const max = Number(node.max_children_per_orchestrator);
  const stale = Number(node.in_flight_stale_after_ms);
  return {
    max: Number.isInteger(max) && max > 0 ? max : DEFAULT_STRUCTURAL_CAPS.max,
    staleAfterMs: Number.isFinite(stale) && stale > 0 ? stale : DEFAULT_STRUCTURAL_CAPS.staleAfterMs,
  };
}

/** How a provider runs workers per the table (`in-session-subagent`, `headless`, …), if declared. */
export function providerExecution(table: RoutingTable, provider: string): string | undefined {
  const e = table.providers[provider]?.execution;
  return typeof e === 'string' ? e : undefined;
}

export function listTaskClasses(table: RoutingTable): string[] {
  return Object.keys(table.taskClasses);
}

/**
 * The "code-editing class" classifier: does a dispatch of `taskClass` change files? Data-driven
 * from the table's `edits_code:` field — never inferred from the class name. Unknown classes and
 * direct routes (`direct:<provider>/<model>`) are NOT code-editing as far as the table knows.
 */
export function isCodeEditingClass(table: RoutingTable, taskClass: string): boolean {
  const node = (table.taskClasses as any)[taskClass];
  return Boolean(node) && node.edits_code === true;
}

/** One row per task class — the shared shape behind `list_task_classes` (MCP) and `heddle classes`. */
export interface TaskClassDescription {
  task_class: string;
  provider: string;
  model: string;
  /** How the provider runs workers (`in-session-subagent` means: use your own Agent tool). */
  execution: string | null;
  effort: string | null;
  fallback: string | null;
  opt_in_required: boolean;
  note: string | null;
  why: string | null;
  /**
   * The packs a dispatch of this class receives when the caller omits `skills` — the table's
   * default with the mandatory pack(s) unioned in, i.e. exactly what the ledger will record.
   */
  skills: string[];
  mcp: string[];
  edits_code: boolean;
  /** False for the orchestrator's own class (`orchestration`): every dispatch of it is refused. */
  dispatchable: boolean;
}

/**
 * Describe every task class with its routing AND its dispatch-time guidance (why + default skill
 * packs + edits_code). `withMandatory` mirrors the dispatcher's own union rule so the listed
 * `skills` are what a worker actually gets — pass `withMandatoryPacks` from skillpacks.ts.
 */
export function describeTaskClasses(
  table: RoutingTable, withMandatory: (skills: string[]) => string[] = (s) => s,
): TaskClassDescription[] {
  return listTaskClasses(table).map((c) => {
    const r = resolveRoute(table, c);
    const execution = table.providers[r.provider]?.execution;
    return {
      task_class: c,
      provider: r.provider,
      model: r.model,
      execution: typeof execution === 'string' ? execution : null,
      effort: r.effort ?? null,
      fallback: r.fallback ? `${r.fallback.provider}/${r.fallback.model}` : null,
      opt_in_required: r.requiresExplicitOptIn ?? false,
      note: r.note ?? null,
      why: r.why ?? null,
      // A non-dispatchable class never gets a worker, so no mandatory worker pack applies (matches
      // the refusal path in dispatch.ts, which records no skills for it).
      skills: r.dispatchable ? withMandatory(r.skills ?? []) : (r.skills ?? []),
      mcp: r.mcp ?? [],
      edits_code: r.editsCode,
      dispatchable: r.dispatchable,
    };
  });
}

/**
 * Direct route — the orchestrator names a provider+model itself instead of a task class.
 * This is the "call whatever model is best for the job" escape hatch: full dynamic choice,
 * but still fenced by the subscription policy (excluded/held providers refuse here, and the
 * per-adapter misbilling guards — e.g. no claude/gpt/gemini ids through Cursor — still apply
 * at dispatch time). No fallback and no opt-in gate: naming a model IS the opt-in.
 */
export function directRoute(
  table: RoutingTable, provider: string, model: string, skills?: string[], mcp?: string[],
): Route {
  const cfg = table.providers[provider];
  if (!cfg) {
    throw new Error(`unknown provider "${provider}". Known: ${Object.keys(table.providers).join(', ')}`);
  }
  if (cfg.status === 'excluded') throw new Error(`provider "${provider}" is excluded from orchestration`);
  if (cfg.status === 'held') throw new Error(`provider "${provider}" is on hold and not routable yet`);
  return { taskClass: `direct:${provider}/${model}`, provider, model, skills, mcp, editsCode: false, dispatchable: true };
}
