import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { gitRepositoryAtPath, gitRepositoryFor } from './worktree.js';

/**
 * HED-723: which checkouts the machine's memtrace workspaces already index, and whether a dispatch
 * cwd is a SECOND copy of one of them.
 *
 * `memtrace mcp` with no workspace flag anchors on its working directory (its own `--help`). Observed
 * 2026-10-06: inside an indexed checkout or one of its linked worktrees it serves from the shared
 * store, while inside a standalone `git clone` of the same repository it started a private
 * `memcore-server` + `memcortex-daemon` for the whole repository — 5.9 GB within five minutes, and
 * 1.1–1.6 GB of `.memdb` on disk per clone. This module only answers "is this cwd such a clone?";
 * the refusal lives with the other plan-level gates (dispatcher/plan.ts, dispatch.ts).
 *
 * Coupling, stated plainly: the member list is read from memtrace's own workspace manifests
 * (`~/.memtrace/workspaces/*.toml`, `[[members]] path = "<checkout>"`). Every read fails OPEN — a
 * missing directory, an unreadable or non-TOML file, or a manifest without members contributes
 * nothing, and with no known member no dispatch is ever refused here.
 */

/** Checkout paths the memtrace workspace manifests list as members, in manifest order, de-duplicated. */
export function readMemtraceWorkspaceRoots(): string[] {
  const dir = join(homedir(), '.memtrace', 'workspaces');
  let manifests: string[];
  try { manifests = readdirSync(dir).filter((name) => name.endsWith('.toml')).sort(); }
  catch { return []; }
  const roots: string[] = [];
  for (const manifest of manifests) {
    try {
      const members = parseToml(readFileSync(join(dir, manifest), 'utf8')).members;
      if (!Array.isArray(members)) continue;
      for (const member of members) {
        const path = (member as { path?: unknown } | null)?.path;
        if (typeof path === 'string' && isAbsolute(path) && !roots.includes(path)) roots.push(path);
      }
    } catch { /* unreadable or not TOML: this manifest contributes nothing */ }
  }
  return roots;
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** An `origin` that names a checkout on this machine, as a path; null for a network remote. */
function localOrigin(origin: string): string | null {
  if (origin.startsWith('file://')) {
    try { return fileURLToPath(origin); } catch { return null; }
  }
  return isAbsolute(origin) ? origin : null;
}

/**
 * `host/path` identity of a network remote, so `https://host/o/r.git` and `git@host:o/r` compare
 * equal. Only the host is case-folded: a path that differs in case is treated as a different
 * repository (the fail-open side — an unmatched clone is simply not refused).
 */
function remoteKey(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  let host: string;
  let path: string;
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    host = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    const scpLike = /^([^/:]+):(.+)$/.exec(trimmed);
    if (!scpLike) return null;
    [, host, path] = scpLike;
  }
  host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  path = path.split(/[?#]/, 1)[0].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return host && path ? `${host}/${path}` : null;
}

/**
 * A clone made from a clone still ends at the indexed repository. The walk back to it stops at a loop of
 * origins (each local repository is visited once) and, to bound its cost at two git calls a hop, after
 * this many hops — a longer chain is not followed and fails open.
 */
const MAX_ORIGIN_HOPS = 32;

export interface IndexedRepoClone {
  /** The top level of the checkout `cwd` is in. */
  clone: string;
  /** The main checkout of the indexed repository it is a second copy of. */
  member: string;
}

/**
 * The indexed repository `cwd` is a standalone clone of, else null.
 *
 * A repository is identified by its MAIN checkout (gitRepositoryFor), never by a path prefix: a
 * consumer fleet's linked worktrees are siblings of the checkout they belong to, and a manifest may
 * list a linked worktree rather than the main checkout. So `cwd` is NOT a clone when its repository's
 * main checkout is an indexed one. Otherwise its `origin` is followed — through local clones of
 * clones, bare mirrors and `.git` directories — until it names an indexed repository (a local path
 * inside one, or the network remote one of them has). No repository, an unknown identity, no origin,
 * an origin `git clone` never writes (a relative path), or an unrelated repository: null.
 */
export function standaloneCloneOfIndexedRepo(cwd: string, roots: readonly string[]): IndexedRepoClone | null {
  if (roots.length === 0) return null;
  const repo = gitRepositoryFor(cwd);
  if (!repo?.mainRoot) return null;
  const listed = new Set(roots.map(real));
  const main = real(repo.mainRoot);
  if (listed.has(main)) return null;
  const members = indexedMembers(listed);
  if (members.has(main)) return null;
  const member = indexedUpstream(repo.originUrl, members, main);
  return member ? { clone: repo.topLevel, member } : null;
}

/** Main checkout → its origin (if any) for each listed root; a root git cannot read keys as itself. */
function indexedMembers(listed: ReadonlySet<string>): Map<string, string | null> {
  const members = new Map<string, string | null>();
  for (const root of listed) {
    const member = gitRepositoryFor(root);
    members.set(member?.mainRoot ? real(member.mainRoot) : root, member?.originUrl ?? null);
  }
  return members;
}

/** The member whose network remote is `origin`, else null. */
function memberWithRemote(origin: string, members: ReadonlyMap<string, string | null>): string | null {
  const wanted = remoteKey(origin);
  if (!wanted) return null;
  for (const [member, memberOrigin] of members) {
    if (memberOrigin && remoteKey(memberOrigin) === wanted) return member;
  }
  return null;
}

/** The member `origin` leads back to through local repositories, else null; `start` is the clone's own main checkout. */
function indexedUpstream(origin: string | null, members: ReadonlyMap<string, string | null>, start: string): string | null {
  const visited = new Set<string>([start]);
  for (let hop = 0; origin && hop < MAX_ORIGIN_HOPS; hop += 1) {
    const source = localOrigin(origin);
    if (!source) return memberWithRemote(origin, members);
    // The origin may name a bare mirror or a `.git` directory rather than a checkout: a bare
    // repository is never itself a member, so its own origin is followed instead.
    const upstream = gitRepositoryAtPath(source);
    if (!upstream) return null;
    const upstreamMain = real(upstream.mainRoot);
    if (!upstream.bare && members.has(upstreamMain)) return upstreamMain;
    if (visited.has(upstreamMain)) return null; // a loop of origins never reaches an indexed repository
    visited.add(upstreamMain);
    origin = upstream.originUrl;
  }
  return null;
}
