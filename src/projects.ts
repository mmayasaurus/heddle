import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

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

/**
 * Canonical absolute form of a path for cross-checking a root against a cwd: dereferences symlinks
 * via realpathSync (so a root registered as `/tmp/x` matches a cwd of `/private/tmp/x`, and a
 * symlinked checkout matches its real path). FALLS BACK to lexical resolve() when the path does not
 * yet exist on disk — realpathSync throws on a missing path, and a workspace root may legitimately
 * point at a not-yet-created checkout; failing soft there matches the loader's fail-soft-on-absence
 * philosophy (a still-absent root simply won't match any cwd, exactly as before). The catch is a
 * deliberate fallback, not a swallowed error. Both a project's roots (once, at load) and the cwd
 * (per lookup) pass through here so the two sides are always compared in the same canonical space.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // Path absent (or unreadable) → lexical resolve keeps it absolute without touching the FS.
    return resolve(p);
  }
}

/** A required string field — loud on missing/wrong-type, same discipline as routing.ts's listField. */
function requireString(node: any, key: string, where: string, path: string): string {
  const v = node[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`projects.json at ${path}: ${where}.${key} must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** A required string-array field — loud on non-array, empty array, or any blank/non-string element
 *  (an empty workspaceRoot resolves to cwd — dangerous, so blank elements are rejected outright). */
function requireStringArray(node: any, key: string, where: string, path: string): string[] {
  const v = node[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
    throw new Error(`projects.json at ${path}: ${where}.${key} must be a non-empty array of non-blank strings (got ${JSON.stringify(v)})`);
  }
  return v;
}

function toProject(node: any, index: number, path: string): Project {
  if (!node || typeof node !== 'object') {
    throw new Error(`projects.json at ${path}: projects[${index}] must be an object (got ${JSON.stringify(node)})`);
  }
  const where = typeof node.name === 'string' && node.name ? `project "${node.name}"` : `projects[${index}]`;
  const name = requireString(node, 'name', where, path);
  const workspaceRoots = requireStringArray(node, 'workspaceRoots', where, path);
  for (const root of workspaceRoots) {
    if (!isAbsolute(root)) {
      throw new Error(
        `projects.json at ${path}: ${where}.workspaceRoots contains a non-absolute path "${root}" — workspace roots must be absolute`,
      );
    }
  }
  return {
    name,
    // Canonicalized once here (symlinks dereferenced, made absolute) so projectForCwd never touches
    // the filesystem inside its matching loop, and both sides of every comparison share one space.
    workspaceRoots: workspaceRoots.map((root) => canonicalize(root)),
    agentIds: requireStringArray(node, 'agentIds', where, path),
    linearTeam: requireString(node, 'linearTeam', where, path),
    defaultRoom: requireString(node, 'defaultRoom', where, path),
    launcher: requireString(node, 'launcher', where, path),
  };
}

/** Loud when the same agent id (case-insensitive) is claimed by more than one project — a hand-edit
 *  collision must be caught, not silently resolved by first-wins lookup order. */
function checkNoDuplicateAgents(projects: Project[], path: string): void {
  const owner = new Map<string, Project>();
  for (const project of projects) {
    for (const agentId of project.agentIds) {
      const key = agentId.toLowerCase();
      const existing = owner.get(key);
      if (existing && existing !== project) {
        throw new Error(
          `projects.json at ${path}: agent id "${agentId}" is claimed by both "${existing.name}" and "${project.name}" — an agent must belong to exactly one project`,
        );
      }
      if (!existing) owner.set(key, project);
    }
  }
}

/**
 * `~/.heddle/projects.json` → the project↔fleet registry.
 *
 * FAIL-SOFT on absence: a project not yet registered is a normal state, not an error, so a missing
 * file returns an empty registry and lets consumers fall back to cwd inference.
 *
 * LOUD on corruption: this is config Maya edits by hand, not generated output — same philosophy as
 * routing.ts's listField. An unreadable-but-present file, unparseable JSON, a missing/mismatched
 * schemaVersion, a project missing a required field, an empty/blank array element, a non-absolute
 * workspaceRoot, or an agent id claimed by more than one project all throw a clear Error naming the
 * problem, since every consumer parses this file and a version drift — or a hand-edit slip — must be
 * caught, not silently mishandled.
 */
export function validateRegistry(raw: any, path: string): ProjectRegistry {
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
  const projects = raw.projects.map((p: any, i: number) => toProject(p, i, path));
  checkNoDuplicateAgents(projects, path);
  return {
    schemaVersion: raw.schemaVersion,
    projects,
  };
}

export function loadProjectRegistry(path: string = DEFAULT_PROJECTS_PATH): ProjectRegistry {
  // Absence is FAIL-SOFT (empty registry); a PRESENT-but-unreadable file must not fall through to
  // that same path — it needs its own loud error, distinct from "absent" and from "not valid JSON".
  if (!existsSync(path)) return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] };
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`projects.json at ${path} exists but could not be read: ${(err as Error).message}`);
  }
  let raw: any;
  try {
    raw = JSON.parse(contents);
  } catch (err) {
    throw new Error(`projects.json at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validateRegistry(raw, path);
}

/**
 * True when `target` equals `root` or sits under it on a path SEGMENT boundary (`/a/foo` must not
 * match `/a/foobar`). Compared case-insensitively (deliberate tradeoff: on a case-sensitive Linux FS
 * this could over-match two roots differing only by case — an acceptable, negligible risk for a
 * project registry, versus the real macOS/Windows cwd-casing miss it prevents).
 */
export function isAncestorOrEqual(root: string, target: string): boolean {
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (rootLower === targetLower) return true;
  const prefix = rootLower.endsWith(sep) ? rootLower : rootLower + sep;
  return targetLower.startsWith(prefix);
}

/**
 * The project one of whose `workspaceRoots` is an ancestor of (or equal to) `cwd`. workspaceRoots
 * are canonicalized to absolute paths once at load time (toProject); `cwd` is canonicalized here the
 * same way, so a symlinked cwd matches its real registered root. When more than one root matches
 * (nested workspace roots, possibly across different projects), the LONGEST matching root wins. null
 * when nothing matches.
 */
export function projectForCwd(reg: ProjectRegistry, cwd: string): Project | null {
  const target = canonicalize(cwd);
  let best: Project | null = null;
  let bestRootLength = -1;
  for (const project of reg.projects) {
    for (const root of project.workspaceRoots) {
      if (!isAncestorOrEqual(root, target)) continue;
      if (root.length > bestRootLength) {
        best = project;
        bestRootLength = root.length;
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
