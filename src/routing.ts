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
  /** Capabilities granted by default for this route (e.g. ["browse"]). */
  capabilities?: string[];
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
  /** True when this class must only resolve to providers that can perform live web research. */
  requiresWeb: boolean;
  /**
   * False when the class is the orchestrator's OWN work and is never delegated (YAML
   * `dispatchable: false`, today only `orchestration`): dispatching it is refused with an
   * instruction to continue in-session, and no delegated-worker pack is suggested. Default true.
   */
  dispatchable: boolean;
  /** HED-3: the worker must not change the worktree (read-only sandbox where possible + git snapshot check). */
  readOnly: boolean;
  /** HED-3: run assess_result on the worker's output and attach the assessment. */
  autoAssess: boolean;
  /** HED-3: ordered alternatives when the caller's `author_provider` matches the route (a reviewer must differ). */
  reviewerPool?: { provider: string; model: string }[];
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
    capabilities: listField(node, 'capabilities', where),
    requiresExplicitOptIn: node.requires_explicit_opt_in === true,
    note: node.note,
  };
}

/**
 * Own-property provider lookup. A task class, fallback, or reviewer_pool entry naming an INHERITED
 * property (`toString`, `constructor`, …) must read as an UNKNOWN provider — never the prototype
 * method that a bare `table.providers[name]` returns for it (a truthy function that passes a `!cfg`
 * guard yet has no `.status`, so it slips every policy check and yields an invalid route). cubic #63.
 */
export function providerConfig(
  table: RoutingTable, provider: string,
): Record<string, unknown> | undefined {
  return Object.hasOwn(table.providers, provider) ? table.providers[provider] : undefined;
}

/**
 * Assert a (provider, model) target is routable under policy: the provider is a known OWN entry, not
 * excluded and not held, and — for Cursor — not a direct-subscription family (policy.never_via_cursor).
 * `subject` prefixes the error so primary / fallback callers get a self-describing message. Shared by
 * both paths so the guard cannot drift between them (the +complexity/duplication codacy/copilot #63
 * flagged lived in having these four checks written twice).
 */
function assertRoutableTarget(table: RoutingTable, provider: string, model: string, subject: string): void {
  const cfg = providerConfig(table, provider);
  if (!cfg) throw new Error(`${subject} names unknown provider "${provider}"`);
  if (cfg.status === 'excluded') throw new Error(`${subject} routes to excluded provider "${provider}"`);
  if (cfg.status === 'held') throw new Error(`${subject} provider "${provider}" is on hold and not routable yet`);
  if (provider === 'cursor' && isNeverViaCursor(table, model)) {
    throw new Error(`${subject} model "${model}" is a direct-subscription family — never route it through Cursor (policy.never_via_cursor)`);
  }
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
  assertRoutableTarget(table, primary.provider, primary.model, `task class "${taskClass}"`);
  // The fallback is a different ROUTE for the same CLASS, so class-level policy (skill packs, MCP
  // servers) carries over unless the fallback node sets its own. Effort deliberately does not: its
  // vocabulary is per provider (codex minimal…xhigh vs agy low|medium|high; cursor bakes it into
  // the model id), so a primary's effort would be wrong or rejected on another provider.
  const fb = toTarget(node.fallback, `task_classes.${taskClass}.fallback`);
  if (fb) {
    if (!fb.provider || !fb.model) {
      throw new Error(`task class "${taskClass}": fallback is missing provider or model`);
    }
    // Same policy checks as the primary, surfaced at resolve time — not after the primary failed.
    assertRoutableTarget(table, fb.provider, fb.model, `task class "${taskClass}": fallback`);
  }
  const fallback = fb ? {
    ...fb,
    skills: fb.skills ?? primary.skills,
    mcp: fb.mcp ?? primary.mcp,
    capabilities: fb.capabilities ?? primary.capabilities,
  } : undefined;
  return {
    taskClass,
    ...primary,
    fallback,
    why: typeof node.why === 'string' ? node.why : undefined,
    editsCode: node.edits_code === true,
    requiresWeb: node.requires_web === true,
    dispatchable: node.dispatchable !== false,
    readOnly: node.read_only === true,
    autoAssess: node.auto_assess === true,
    reviewerPool: Array.isArray(node.reviewer_pool)
      ? (node.reviewer_pool as any[]).filter((e) => e && typeof e.provider === 'string' && typeof e.model === 'string')
          .map((e) => ({ provider: e.provider as string, model: e.model as string }))
      : undefined,
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

// policy.never_via_cursor lists FAMILIES; FAMILY_PREFIXES maps each to its model-id prefixes
// (o1-/o3- are OpenAI 'gpt' family).
export const FAMILY_PREFIXES: Record<string, string[]> = {
  claude: ['claude-'],
  gpt: ['gpt-', 'o1-', 'o3-'],
  gemini: ['gemini-'],
};

export function neverViaCursorPrefixes(table: RoutingTable): string[] {
  const raw = (table.policy as any)?.never_via_cursor;
  // Fail SAFE: only a NON-EMPTY, all-string list is honored as tuning; a missing / non-array / EMPTY /
  // non-string-containing never_via_cursor defaults to ALL known direct-subscription families (refuse
  // them), NEVER [] — an empty or malformed list would silently disable the billing guard at route
  // resolution (codeant #63; the empty-list and non-string holes, cubic #63).
  const fams = Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')
    ? (raw as string[]) : Object.keys(FAMILY_PREFIXES);
  // Case-fold each family and use an OWN-property lookup: a synthesized `${f}-` for an unknown family
  // must be lowercased (else an uppercase policy family like `Groq` yields `Groq-` and never matches the
  // lowercased model — cubic #63), and `FAMILY_PREFIXES[f]` for a prototype key like `toString` must not
  // return the inherited method (which would embed a function in the prefix list and crash the compare).
  return fams.flatMap((f) => {
    const fam = f.toLowerCase();
    return Object.hasOwn(FAMILY_PREFIXES, fam) ? FAMILY_PREFIXES[fam] : [`${fam}-`];
  });
}

/** True if `model` must never route through Cursor (a direct-subscription family). CASE-INSENSITIVE —
 *  model ids come from external callers (directRoute takes req.model), so `GPT-5.6` / `Claude-3` must
 *  not slip past both this check AND the adapter fail-safe, which shared the same case logic (gitar #63). */
export function isNeverViaCursor(table: RoutingTable, model: string): boolean {
  const m = model.toLowerCase();
  return neverViaCursorPrefixes(table).some((p) => m.startsWith(p));
}

export function structuralCaps(table: RoutingTable): StructuralCaps {
  // route_away_at_pct under metered_pool_guard is declared intent only: enforcement needs the
  // Cursor usage source (HED-9). reviewer_fleet_isolation and official_binaries_only remain declared-intent.
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
  /** HED-3 review classes: worker may not change the worktree; assessment attached; alternatives when the author's provider matches. */
  read_only: boolean;
  auto_assess: boolean;
  reviewer_pool: string[];
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
      read_only: r.readOnly,
      auto_assess: r.autoAssess,
      reviewer_pool: (r.reviewerPool ?? []).map((e) => `${e.provider}/${e.model}`),
    };
  });
}

/**
 * Direct route — the orchestrator names a provider+model itself instead of a task class.
 * This is the "call whatever model is best for the job" escape hatch: full dynamic choice,
 * but still fenced by the subscription policy (excluded/held providers and direct-subscription
 * families through Cursor refuse here). No fallback and no opt-in gate: naming a model IS the opt-in.
 */
export function directRoute(
  table: RoutingTable, provider: string, model: string, skills?: string[], mcp?: string[],
): Route {
  const cfg = providerConfig(table, provider);
  if (!cfg) {
    throw new Error(`unknown provider "${provider}". Known: ${Object.keys(table.providers).join(', ')}`);
  }
  if (cfg.status === 'excluded') throw new Error(`provider "${provider}" is excluded from orchestration`);
  if (cfg.status === 'held') throw new Error(`provider "${provider}" is on hold and not routable yet`);
  if (provider === 'cursor' && isNeverViaCursor(table, model)) {
    throw new Error(`model "${model}" is a direct-subscription family — never route it through Cursor (policy.never_via_cursor)`);
  }
  return { taskClass: `direct:${provider}/${model}`, provider, model, skills, mcp, editsCode: false, requiresWeb: false, dispatchable: true, readOnly: false, autoAssess: false };
}
