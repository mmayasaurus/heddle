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

/** A scheme's default port names the same server as no port at all; any other port may be another server. */
const DEFAULT_PORTS: Record<string, string> = { ssh: '22', 'git+ssh': '22', 'ssh+git': '22', git: '9418', http: '80', https: '443' };

/**
 * `host/path` identity of a network remote, so `https://host/o/r.git` and `git@host:o/r` compare
 * equal. Only the host is case-folded: a path that differs in case is treated as a different
 * repository (the fail-open side — an unmatched clone is simply not refused). A non-default port
 * stays part of the host.
 */
function remoteKey(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  let host: string;
  let path: string;
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    host = rest.slice(0, slash).replace(/^[^@]*@/, '');
    path = rest.slice(slash + 1);
    const port = /:(\d+)$/.exec(host);
    if (port && port[1] === DEFAULT_PORTS[scheme[1].toLowerCase()]) host = host.slice(0, port.index);
  } else {
    const scpLike = /^([^/:]+):(.+)$/.exec(trimmed);
    if (!scpLike) return null;
    [, host, path] = scpLike;
    host = host.replace(/^[^@]*@/, '');
  }
  host = host.toLowerCase();
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
 * main checkout is an indexed one. Otherwise its remote (`origin`, else the first one) is followed —
 * through local clones of clones, bare mirrors and `.git` directories — until it names an indexed
 * repository (a local path inside one, a local repository on one's own origin chain, or the network
 * remote that chain ends at). No repository, an unknown identity, no remote, a remote `git clone`
 * never writes (a relative path), or an unrelated repository: null.
 */
export function standaloneCloneOfIndexedRepo(cwd: string, roots: readonly string[]): IndexedRepoClone | null {
  if (roots.length === 0) return null;
  const repo = gitRepositoryFor(cwd);
  if (!repo?.mainRoot) return null;
  const listed = new Set(roots.map(real));
  const main = real(repo.mainRoot);
  if (listed.has(main)) return null;
  const members = indexedMembers(listed);
  if (members.remotes.has(main)) return null;
  const member = indexedUpstream(gitRepositoryAtPath(repo.topLevel)?.remoteUrl ?? null, members, main);
  return member ? { clone: repo.topLevel, member } : null;
}

/** The indexed repositories, each keyed by its main checkout (a root git cannot read keys as itself). */
interface IndexedMembers {
  /** Main checkout → the network remote its own origin chain ends at (its remote, or one reached through local copies), if any. */
  remotes: Map<string, string | null>;
  /** A local repository on a member's own origin chain (the bare mirror it was cloned from, say, or that mirror's source) → that member. */
  bySource: Map<string, string>;
}

function indexedMembers(listed: ReadonlySet<string>): IndexedMembers {
  const remotes = new Map<string, string | null>();
  const bySource = new Map<string, string>();
  for (const root of listed) {
    const member = gitRepositoryAtPath(root);
    const key = member ? real(member.mainRoot) : root;
    remotes.set(key, memberNetworkRemote(member?.remoteUrl ?? null, key, bySource));
  }
  return { remotes, bySource };
}

/**
 * Walks a member's own origin chain the way indexedUpstream walks a clone's: every local repository on it
 * is recorded in `bySource` as leading back to `member` (the first member to reach one keeps it), and the
 * network remote the chain ends at is returned. So a clone of that remote, or of any local copy on the way,
 * matches the member even when the member itself was cloned from a local copy.
 */
function memberNetworkRemote(remote: string | null, member: string, bySource: Map<string, string>): string | null {
  const visited = new Set<string>([member]);
  for (let hop = 0; remote && hop < MAX_ORIGIN_HOPS; hop += 1) {
    const source = localOrigin(remote);
    if (!source) return remote;
    const upstream = gitRepositoryAtPath(source);
    if (!upstream) return null;
    const upstreamMain = real(upstream.mainRoot);
    if (visited.has(upstreamMain)) return null; // a loop of remotes never reaches a network remote
    visited.add(upstreamMain);
    if (!bySource.has(upstreamMain)) bySource.set(upstreamMain, member);
    remote = upstream.remoteUrl;
  }
  return null;
}

/** The member whose network remote is `remote`, else null. */
function memberWithRemote(remote: string, remotes: ReadonlyMap<string, string | null>): string | null {
  const wanted = remoteKey(remote);
  if (!wanted) return null;
  for (const [member, memberRemote] of remotes) {
    if (memberRemote && remoteKey(memberRemote) === wanted) return member;
  }
  return null;
}

/** The member `remote` leads back to through local repositories, else null; `start` is the clone's own main checkout. */
function indexedUpstream(remote: string | null, members: IndexedMembers, start: string): string | null {
  const visited = new Set<string>([start]);
  for (let hop = 0; remote && hop < MAX_ORIGIN_HOPS; hop += 1) {
    const source = localOrigin(remote);
    if (!source) return memberWithRemote(remote, members.remotes);
    // The remote may name a bare mirror or a `.git` directory rather than a checkout: a bare
    // repository is never itself a member, so its own remote is followed instead.
    const upstream = gitRepositoryAtPath(source);
    if (!upstream) return null;
    const upstreamMain = real(upstream.mainRoot);
    if (!upstream.bare && members.remotes.has(upstreamMain)) return upstreamMain;
    // Cloned from a local repository on a member's own origin chain (siblings of one mirror, say): the same repository.
    const sibling = members.bySource.get(upstreamMain);
    if (sibling) return sibling;
    if (visited.has(upstreamMain)) return null; // a loop of remotes never reaches an indexed repository
    visited.add(upstreamMain);
    remote = upstream.remoteUrl;
  }
  return null;
}
