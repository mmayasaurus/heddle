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
  extraFlags?: string[];
  skills?: string[];
  requiresExplicitOptIn?: boolean;
  note?: string;
}

export interface Route extends RouteTarget {
  taskClass: string;
  fallback?: RouteTarget;
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

function toTarget(node: any): RouteTarget | undefined {
  if (!node) return undefined;
  return {
    provider: node.provider,
    model: node.model,
    // Provider-specific flag keys stay explicit rather than magic: codex_flags today.
    extraFlags: node.codex_flags ?? node.extra_flags,
    skills: node.skills,
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
  const primary = toTarget(node)!;
  if (!primary.provider || !primary.model) {
    throw new Error(`task class "${taskClass}" is missing provider or model`);
  }
  const providerCfg = table.providers[primary.provider];
  if (providerCfg?.status === 'excluded') {
    throw new Error(`task class "${taskClass}" routes to excluded provider "${primary.provider}"`);
  }
  return { taskClass, ...primary, fallback: toTarget(node.fallback) };
}

export function listTaskClasses(table: RoutingTable): string[] {
  return Object.keys(table.taskClasses);
}
