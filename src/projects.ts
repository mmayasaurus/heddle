import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Project↔fleet registry (HED-160) — binds a project (a named set of workspace roots) to its
 * dedicated fleet: agent ids, Linear team, default chat room, and session launcher. This is the
 * single source of truth for "which agents belong to which project" (Maya: "I want to open the
 * Spinventory project inside heddle — the dashboard shows Agents A through Q, chatrooms with just
 * Spinventory agents").
 *
 * Lives at the FRAMEWORK layer (`~/.heddle/projects.json`), never inside a project repo, because it
 * spans tenants — today Spinventory and heddle itself, more later. Same layer as
 * `~/.heddle/accounts.json` (src/capaware.ts). See docs/PROJECTS.md for the full schema and the
 * registry-as-truth / cwd-inference-as-fallback consumer contract.
 *
 * This module is CORE only: the loader and the two lookups. Wiring it into the roster, chatroom, or
 * launcher is separate follow-up work (later HED-160 lanes) and deliberately not done here.
 */

export const PROJECTS_SCHEMA_VERSION = 1;

export interface Project {
  name: string;
  workspaceRoots: string[];
  agentIds: string[];
  linearTeam: string;
  defaultRoom: string;
  launcher: string;
}

export interface ProjectRegistry {
  schemaVersion: number;
  projects: Project[];
}

export const DEFAULT_PROJECTS_PATH = join(homedir(), '.heddle', 'projects.json');

/** A required string field — loud on missing/wrong-type, same discipline as routing.ts's listField. */
function requireString(node: any, key: string, where: string): string {
  const v = node[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`projects.json: ${where}.${key} must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** A required string-array field — loud on non-array or a non-string element. */
function requireStringArray(node: any, key: string, where: string): string[] {
  const v = node[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`projects.json: ${where}.${key} must be an array of strings (got ${JSON.stringify(v)})`);
  }
  return v;
}

function toProject(node: any, index: number): Project {
  if (!node || typeof node !== 'object') {
    throw new Error(`projects.json: projects[${index}] must be an object (got ${JSON.stringify(node)})`);
  }
  const where = typeof node.name === 'string' && node.name ? `project "${node.name}"` : `projects[${index}]`;
  return {
    name: requireString(node, 'name', where),
    workspaceRoots: requireStringArray(node, 'workspaceRoots', where),
    agentIds: requireStringArray(node, 'agentIds', where),
    linearTeam: requireString(node, 'linearTeam', where),
    defaultRoom: requireString(node, 'defaultRoom', where),
    launcher: requireString(node, 'launcher', where),
  };
}

/**
 * `~/.heddle/projects.json` → the project↔fleet registry.
 *
 * FAIL-SOFT on absence: a project not yet registered is a normal state, not an error, so a missing
 * file returns an empty registry and lets consumers fall back to cwd inference.
 *
 * LOUD on corruption: this is config Maya edits by hand, not generated output — same philosophy as
 * routing.ts's listField. Unparseable JSON, a missing/mismatched schemaVersion, or a project missing
 * a required field / with a non-array workspaceRoots|agentIds all throw a clear Error naming the
 * problem, since every consumer parses this file and a version drift must be caught, not silently
 * mishandled.
 */
export function loadProjectRegistry(path: string = DEFAULT_PROJECTS_PATH): ProjectRegistry {
  if (!existsSync(path)) return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`projects.json at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`projects.json at ${path} must be a JSON object (got ${JSON.stringify(raw)})`);
  }
  if (raw.schemaVersion !== PROJECTS_SCHEMA_VERSION) {
    throw new Error(
      `projects.json at ${path} has schemaVersion ${JSON.stringify(raw.schemaVersion)}, expected ${PROJECTS_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(raw.projects)) {
    throw new Error(`projects.json at ${path}: "projects" must be an array (got ${JSON.stringify(raw.projects)})`);
  }
  return {
    schemaVersion: raw.schemaVersion,
    projects: raw.projects.map((p: any, i: number) => toProject(p, i)),
  };
}

/** True when `target` equals `root` or sits under it on a path SEGMENT boundary (`/a/foo` must not match `/a/foobar`). */
function isAncestorOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * The project one of whose `workspaceRoots` is an ancestor of (or equal to) `cwd`. Both sides are
 * resolved/normalized before comparing. When more than one root matches (nested workspace roots,
 * possibly across different projects), the LONGEST matching root wins. null when nothing matches.
 */
export function projectForCwd(reg: ProjectRegistry, cwd: string): Project | null {
  const target = resolve(cwd);
  let best: Project | null = null;
  let bestRootLength = -1;
  for (const project of reg.projects) {
    for (const root of project.workspaceRoots) {
      const normalizedRoot = resolve(root);
      if (!isAncestorOrEqual(normalizedRoot, target)) continue;
      if (normalizedRoot.length > bestRootLength) {
        best = project;
        bestRootLength = normalizedRoot.length;
      }
    }
  }
  return best;
}

/** The project whose `agentIds` includes `agentId` (case-insensitive). null when nothing matches. */
export function projectForAgent(reg: ProjectRegistry, agentId: string): Project | null {
  const target = agentId.toLowerCase();
  for (const project of reg.projects) {
    if (project.agentIds.some((id) => id.toLowerCase() === target)) return project;
  }
  return null;
}
