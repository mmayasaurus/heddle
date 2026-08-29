import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { withFileLock } from './matlock.js';
import { gitRepositoryFor, type GitRepository } from './worktree.js';

/**
 * Skill-pack materializer.
 *
 * A "skill pack" is a markdown instruction bundle. Each CLI auto-loads instructions its own way,
 * so heddle composes the requested packs and writes them where the target worker will actually
 * read them:
 *   - Codex / agy / Cursor → AGENTS.md at the worktree root (all three auto-load it; Cursor also
 *     reads CLAUDE.md and .cursor/rules).
 *   - Claude → not a file; packs map onto agent-definition frontmatter (`skills:`), handled by
 *     the orchestrator, not here.
 *
 * Lean by default: measured auto-load overhead is real (~22k input tokens/invocation on a fully
 * loaded global Codex config, ~18k on agy), so packs attach only what a task needs.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** heddle's own packs — the generic ones every consumer inherits. */
export function builtinPacksDir(): string {
  return join(here, '..', 'skills');
}

/**
 * Pack SEARCH PATH, consumer dirs first (HED-33/HED-93).
 *
 * `HEDDLE_PACKS` is a colon-separated list of CONSUMER pack directories — a project keeps its own
 * conventions in its own repo (e.g. `<project>/.heddle/packs`) instead of shipping them inside
 * heddle. heddle's built-in dir is ALWAYS searched last, so a consumer gets its own packs PLUS the
 * generic ones (worker-role, worker-hygiene, family-*) rather than replacing them.
 *
 * This layering is the whole point: the earlier shape treated HEDDLE_PACKS as a REPLACEMENT, so
 * pointing it at a consumer dir silently removed the mandatory packs and every dispatch died with
 * "skill pack not found" (found by pointing it at a real consumer dir, 2026-08-17).
 *
 * A consumer pack SHADOWS a built-in of the same name — deliberate, so a project can specialize
 * e.g. `quality-gate` without forking heddle.
 */
export function packDirs(): string[] {
  // node:path's `delimiter` — ':' on POSIX, ';' on Windows. A literal ':' would split a Windows
  // drive-letter path (C:\project\.heddle\packs) into two invalid directories (PR #34, 5 reviewers).
  const consumer = (process.env.HEDDLE_PACKS ?? '')
    .split(delimiter).map((d) => d.trim()).filter(Boolean);
  return [...consumer, builtinPacksDir()];
}

/** First directory on the search path that holds this pack, or null. */
export function packDirFor(name: string): string | null {
  return packDirs().find((d) => existsSync(join(d, `${name}.md`))) ?? null;
}

/** Back-compat: the directory a bare pack lookup starts from. Prefer packDirs(). */
export function packsDir(): string {
  return packDirs()[0];
}

/** Every pack reachable on the search path, consumer packs shadowing built-ins of the same name. */
export function listPacks(): string[] {
  const seen = new Set<string>();
  for (const dir of packDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) seen.add(f.replace(/\.md$/, ''));
    }
  }
  return [...seen].sort();
}

/**
 * Packs EVERY delegated worker gets, no matter what the routing table or the caller lists.
 * `worker-role` is governance, not task fit: the first real pilot dispatch (2026-08-10) had a codex
 * worker inherit the fleet's claim-before-code policy and refuse to work ("which agent am I?");
 * without it a worker may also claim issues / own PRs it must not. Operator decision, 2026-08-15 (via
 * Agent R): an explicit `skills` list ADDS to policy, it never removes worker-role.
 */
export const MANDATORY_PACKS = ['worker-role', 'worker-hygiene'] as const;

/**
 * MODEL-FAMILY prompting packs (HED-93, operator's idea): each provider family responds to a different
 * instruction STYLE, so routing the same task to a different model should restyle the instructions
 * automatically rather than making every orchestrator remember the differences. Injected by the
 * dispatcher from the target's provider — never named by the caller, so a class that falls back to
 * another family picks up that family's pack on the way.
 *
 * A provider with no entry contributes nothing (absence is not an error): heddle only ships a pack
 * where the fleet has actually learned the family's quirks.
 */
export const MODEL_FAMILY_PACKS: Record<string, string> = {
  codex: 'family-codex',
  gemini: 'family-gemini',
  cursor: 'family-cursor',
  claude: 'family-claude',
};

/** Every family pack name — used to keep a caller from pinning a family that contradicts the one
 *  the dispatcher injects for the target (e.g. an explicit family-codex on a route that falls back
 *  to cursor would hand the worker two conflicting styles). */
export const ALL_FAMILY_PACKS: ReadonlySet<string> = new Set(Object.values(MODEL_FAMILY_PACKS));

/** The family pack for a provider, when one exists AND is installed in the active packs dir. */
export function modelFamilyPack(provider: string): string | null {
  const name = MODEL_FAMILY_PACKS[provider];
  if (!name) return null;
  return packDirFor(name) ? name : null;
}

/**
 * The dispatcher's union rule: mandatory packs first, then the requested packs in their given
 * order, de-duplicated. Applied to BOTH the task-class defaults and a caller's explicit list, on
 * both the task-class and direct provider/model paths — so what the ledger records as `skills` is
 * exactly what was materialized.
 */
export function withMandatoryPacks(skills: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of [...MANDATORY_PACKS, ...(skills ?? [])]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The Spinventory app checkout, by layout: `<parent>/<dir>` — the only place `quality-gate` belongs. */
const APP_CHECKOUT = { dir: 'Rebuild-Project-Root', parent: 'Spinventory-Rebuild-Official' } as const;
/** Main-checkout folder name → that repository's gate pack (exact names only). */
const GATE_BY_FOLDER_NAME: ReadonlyMap<string, string> = new Map([
  ['heddle', 'repo-heddle-core'],
  ['heddle-dashboard', 'repo-heddle-dashboard'],
  ['Spinventory-Rebuild-App', 'repo-workspace'],
]);
/** `origin` repository name (the GitHub name) → gate pack; covers a renamed or relocated clone. */
const GATE_BY_ORIGIN_NAME: ReadonlyMap<string, string> = new Map([
  ['heddle', 'repo-heddle-core'],
  ['heddle-dashboard', 'repo-heddle-dashboard'],
  ['Spinventory-Rebuild-Workspace', 'repo-workspace'],
  ['Spinventory-V2-Official-App-Rebuild', 'quality-gate'],
]);

/** The repository name in a remote URL (`…/owner/name.git`, `git@host:owner/name`), else null. */
export function originRepoName(url: string | null): string | null {
  if (!url) return null;
  // The path part only: a `/` inside a query or fragment must not manufacture a name (round-2 #3).
  const path = url.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const tail = path.split(/[/:]/).pop() ?? '';
  const name = tail.endsWith('.git') ? tail.slice(0, -4) : tail;
  return name || null;
}

/**
 * The gate pack for a repository, or null when the repository is UNKNOWN — the caller then DROPS
 * `quality-gate` rather than guess. `quality-gate` is the Spinventory APP gate (`npm run gate`,
 * expo-router, `cd` into the app checkout); handing it to a worker anywhere else is the fleet-scope
 * violation HED-389 exists to stop, so an unknown identity gets no gate at all.
 *
 * Identity is EXACT, and decided in this order (round-1 review #2/#3/#7):
 *   1. unknown — not a repository, or its main checkout is unlistable → null (never the worktree
 *      folder name, which for a real dispatch cwd is the WORKTREE's name, not the repo's);
 *   2. the app checkout by LAYOUT (main checkout `Rebuild-Project-Root` under a
 *      `Spinventory-Rebuild-Official` parent) → `quality-gate`, checked first so no later rule can
 *      strip the app gate from the app, whatever its `origin` says;
 *   3. the main checkout's exact folder name, corroborated by `origin` when one is configured: a
 *      known folder whose origin names a DIFFERENT or unrecognized repository is ambiguous → null
 *      (codex P2 on PR #95: a folder called `heddle` pointing at `other-project.git` is not heddle);
 *      a known origin alone identifies a renamed or relocated clone.
 * Substring and prefix matches are deliberately absent: an origin that merely CONTAINS a known name,
 * or a folder that starts with one, is not that repository.
 */
export function qualityGateForRepository(repo: GitRepository | null): string | null {
  if (!repo?.mainRoot) return null;
  const rootName = basename(repo.mainRoot);
  if (rootName === APP_CHECKOUT.dir && basename(dirname(repo.mainRoot)) === APP_CHECKOUT.parent) return 'quality-gate';
  const byFolder = GATE_BY_FOLDER_NAME.get(rootName) ?? null;
  const origin = originRepoName(repo.originUrl);
  const byOrigin = origin ? GATE_BY_ORIGIN_NAME.get(origin) ?? null : null;
  if (byFolder && origin && byOrigin !== byFolder) return null; // origin present but not corroborating — no claim
  return byFolder ?? byOrigin;
}

/** A directory's canonical identity: its real path when it exists, else its absolute form. */
function canonicalDir(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/**
 * True when the quality-gate pack readPack would serve is heddle's OWN — the built-in directory (by
 * canonical path, so a HEDDLE_PACKS entry with a trailing slash, a relative form or a symlink still
 * counts) or a byte-identical copy of it (HEDDLE_PACKS pointing at another heddle checkout's
 * skills/). Only that pack is the Spinventory app gate to be resolved per repository; a consumer's
 * own quality-gate pack is theirs to keep. Unreadable → treated as built-in, so app text can never
 * survive by accident (round-3 review #1).
 */
function servesBuiltinQualityGate(): boolean {
  const dir = packDirFor('quality-gate');
  if (!dir || canonicalDir(dir) === canonicalDir(builtinPacksDir())) return true;
  try {
    return readFileSync(join(dir, 'quality-gate.md')).equals(readFileSync(join(builtinPacksDir(), 'quality-gate.md')));
  } catch {
    return true;
  }
}

/**
 * Replace the app-specific quality gate with the gate for the repository that will receive the
 * worker (qualityGateForRepository, from the dispatch cwd). Unknown repositories deliberately
 * receive no quality gate: emitting app instructions into an unrelated checkout is less safe than
 * omitting this task-fit pack.
 */
export function resolveQualityGateForCwd(cwd: string, skills: readonly string[]): string[] {
  if (!skills.includes('quality-gate')) return [...skills];
  // A CONSUMER pack named quality-gate (HEDDLE_PACKS shadowing the built-in) is that project's own
  // gate, chosen by its configuration and read by readPack ahead of the built-in — keep it. Only
  // heddle's built-in quality-gate, the Spinventory APP gate, is repository-resolved (codex P2, #95).
  if (!servesBuiltinQualityGate()) return [...skills];
  const gate = qualityGateForRepository(gitRepositoryFor(cwd));
  if (gate === 'quality-gate') return [...skills];
  const swapped = skills.flatMap((pack) => pack === 'quality-gate' ? (gate ? [gate] : []) : [pack]);
  return swapped.filter((pack, i) => swapped.indexOf(pack) === i); // a caller may already name the repo gate
}

export function readPack(name: string): string {
  const dir = packDirFor(name);
  if (!dir) {
    throw new Error(`skill pack "${name}" not found (searched: ${packDirs().join(', ')})`);
  }
  return readFileSync(join(dir, `${name}.md`), 'utf8').trim();
}

/**
 * The packs as one text block — for CLIs that take instructions on the command line instead of a
 * file (claude `--append-system-prompt`). Same content the AGENTS.md block carries.
 */
export function composePacks(packNames: readonly string[]): string {
  return packNames.map((n) => `### ${n}\n\n${readPack(n)}`).join('\n\n---\n\n');
}

/**
 * Per-dispatch marker pair. The id makes concurrent dispatches into ONE cwd (the normal case,
 * SPEC §5) safe: each dispatch appends, replaces, and removes ONLY its own block (HED-56 — the
 * id-less predecessor raced: dispatch B captured A's block as its "original" and restored it
 * forever, while worker A read B's packs).
 */
const beginMarker = (id: string): string => `<!-- heddle:begin id=${id} -->`;
const endMarker = (id: string): string => `<!-- heddle:end id=${id} -->`;
/** Any heddle block, old id-less format included — used only to recognize heddle-authored spans. */
const ANY_BLOCK = /[ \t]*<!-- heddle:begin( id=([A-Za-z0-9._-]+))? -->[\s\S]*?<!-- heddle:end(?: id=\2)? -->\n?/g;

export interface MaterializeOpts {
  /** Unique per dispatch (the ledger row id). Distinct concurrent dispatches MUST differ. */
  dispatchId: string | number;
  /**
   * Liveness oracle for OTHER dispatches' blocks (ledger in-flight check). A block whose id is not
   * live belongs to a crashed dispatch — it is garbage-collected on the next materialization into
   * that cwd, which also self-heals blocks left by the old id-less format (id undefined → dead).
   */
  isLive?: (dispatchId: string) => boolean;
}

function stripDeadBlocks(content: string, ownId: string, isLive?: (id: string) => boolean): string {
  return content.replace(ANY_BLOCK, (whole, _g1, id?: string) => {
    if (id === ownId) return ''; // a same-id leftover (crashed retry) is always replaced
    if (id && isLive?.(id)) return whole; // a LIVE peer's block stays untouched
    if (id && !isLive) return whole; // no oracle → never GC a peer (only own/legacy)
    return ''; // dead peer, or legacy id-less block: heddle-authored garbage, collect it
  });
}

/**
 * Compose packs into a per-dispatch AGENTS.md block in `cwd`, preserving existing human-authored
 * content AND other live dispatches' blocks. Returns a restore function that removes exactly this
 * dispatch's insertion: the file ends byte-identical for the surviving content whatever order
 * overlapping dispatches finish in, and is deleted only when nothing but whitespace remains.
 */
export function materializeAgentsMd(cwd: string, packNames: string[], opts: MaterializeOpts): () => void {
  const target = join(cwd, 'AGENTS.md');
  if (packNames.length === 0) return () => { /* nothing written */ };
  const ownId = String(opts.dispatchId);

  const body = packNames.map((n) => `### ${n}\n\n${readPack(n)}`).join('\n\n---\n\n');
  const block = `${beginMarker(ownId)}\n<!-- Task-scoped instructions for heddle dispatch #${ownId}. Written by heddle; removed when that dispatch ends. If you are a worker for a DIFFERENT dispatch id, follow your own block only. -->\n\n${body}\n${endMarker(ownId)}`;

  let inserted = '';
  let deletable = false;
  withFileLock(join(cwd, '.heddle-agents.lock'), () => {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    // Deletable at restore time = heddle owns every byte: the file was absent, or contained
    // nothing but heddle marker blocks. A pre-existing file with ANY non-heddle bytes — even
    // whitespace-only (an intentionally-empty AGENTS.md is a real convention) — is NEVER
    // unlinked; the exact-insert removal returns it to its original bytes instead.
    deletable = current === null || current.replace(ANY_BLOCK, '') === '';
    const base = current === null ? null : stripDeadBlocks(current, ownId, opts.isLive);
    if (base === null) {
      inserted = `${block}\n`;
      writeFileSync(target, inserted, 'utf8');
    } else {
      inserted = `${base.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
      writeFileSync(target, base + inserted, 'utf8');
    }
  });

  return () => {
    withFileLock(join(cwd, '.heddle-agents.lock'), () => {
      // Remove exactly what THIS dispatch inserted (other blocks may sit before/after it). If the
      // exact bytes are gone — someone edited INSIDE our block — we LEAVE it: content we cannot
      // verify as ours is never removed (a read-only class records the edit as a mandate
      // violation; a later materialization's dead-block GC reclaims the span, whose markers
      // declare heddle ownership of transient instruction text).
      try {
        const current = readFileSync(target, 'utf8');
        if (!current.includes(inserted)) {
          process.stderr.write(`heddle: dispatch #${ownId}'s AGENTS.md block was edited during the run — leaving it in place (${target})\n`);
          return;
        }
        const next = current.replace(inserted, '');
        // Delete only when heddle owned every original byte AND nothing but whitespace remains —
        // a pre-existing human file (even whitespace-only) keeps its bytes.
        if (deletable && next.trim() === '') unlinkSync(target);
        else writeFileSync(target, next, 'utf8');
      } catch (err) {
        process.stderr.write(`heddle: AGENTS.md restore for dispatch #${ownId} failed (${err instanceof Error ? err.message : String(err)}) — left as is\n`);
      }
    });
  };
}
