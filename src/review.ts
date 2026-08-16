import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from './routing.js';

/**
 * Adversarial review support (HED-3, Maya: "super important"): a DIFFERENT model family reviews a
 * diff/worktree read-only and find-only; the author fixes; the ledger scores each author→reviewer
 * provider pair by accepted-finding rate.
 *
 * Two mechanisms live here:
 *  - `pickReviewer()`: enforce "a reviewer is not the author's provider" using the class's
 *    `reviewer_pool` (routing YAML) — the first entry whose provider differs.
 *  - `snapshotWorktree()` / `sameSnapshot()`: the read-only MANDATE check. Codex and Claude reviewers
 *    get a real read-only sandbox (codex `--sandbox read-only`, claude `--tools Read,Grep,Glob`);
 *    cursor/agy have none, so heddle proves the mandate structurally: a CONTENT digest (HEAD + the
 *    git index + every tracked/untracked non-ignored file's mode+size+content + the stash list)
 *    before and after the run. A changed worktree is a
 *    mandate violation — recorded on the review row and surfaced in the outcome; findings are still
 *    returned (never discard the reviewer's work), nothing is reverted (never delete the reviewer's
 *    or anyone's changes — the operator decides).
 */

export interface ReviewerPick {
  provider: string;
  model: string;
  /** Why this reviewer: `pool:<n> (author is X)` — the nth pool entry taken because the primary matched the author. */
  reason: string;
}

/**
 * Given the class route (primary provider/model + reviewer_pool) and the author's provider, decide
 * the reviewer. Returns null when the author's provider is unknown (nothing to avoid) or when the
 * primary already differs. Throws when NO pool entry differs (the operator must extend the pool).
 */
/** Provider names compare case-insensitively and trimmed ("Cursor " is cursor). */
export function normalizeProvider(p: string | undefined | null): string | undefined {
  const v = p?.trim().toLowerCase();
  return v ? v : undefined;
}

export function pickReviewer(
  route: Route, authorProviderRaw: string | undefined,
  /** Table-level usability gate for a pool entry (provider exists, not excluded, model listed). */
  usable: (provider: string, model: string) => string | null = () => null,
): ReviewerPick | null {
  const authorProvider = normalizeProvider(authorProviderRaw);
  if (!authorProvider) return null;
  // BOTH sides are normalized: YAML casing ("Cursor ") must not dodge the same-family guard.
  if (normalizeProvider(route.provider) !== authorProvider) return null;
  const pool = route.reviewerPool ?? [];
  const skipped: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const provider = normalizeProvider(pool[i].provider);
    if (!provider || provider === authorProvider) continue;
    const unusableReason = usable(provider, pool[i].model);
    if (unusableReason) { skipped.push(`${provider}/${pool[i].model}: ${unusableReason}`); continue; }
    return { provider, model: pool[i].model, reason: `pool:${i + 1} (author is ${authorProvider})` };
  }
  throw new Error(
    `task class "${route.taskClass}": the author's provider is "${authorProvider}" and no reviewer_pool entry ` +
    `${pool.length ? `(${pool.map((e) => e.provider).join(', ')}) ` : ''}is a usable different provider` +
    (skipped.length ? ` (skipped: ${skipped.join('; ')})` : '') +
    ` — an adversarial reviewer must be a different model family; extend reviewer_pool in routing.v0.yaml.`,
  );
}

export interface WorktreeSnapshot {
  /** false when cwd is not inside a git repo (the mandate check is then unavailable, not failed). */
  git: boolean;
  /** sha256 over HEAD + every non-ignored file's path+size+content hash + the stash list. */
  hash: string | null;
  /**
   * Set when a git call failed AFTER the repo was recognized. Judgement is directional
   * (sameSnapshot): a failed AFTER-snapshot is a violation (the reviewer broke a repo that worked);
   * a failed BEFORE-snapshot makes the check unavailable (null) — there is no baseline to compare.
   */
  error?: string;
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * CONTENT digest of the worktree: HEAD (a commit/amend/stash-pop moves it), the git INDEX
 * (`ls-files --stage` — a bare `git add`/`git reset` changes staged oids without touching HEAD or
 * file bytes), every tracked and untracked non-ignored file (path + mode + size + blob oid — a
 * rewrite that keeps the file list unchanged is caught, and so is a chmod), and the stash list (a
 * `git stash` that "cleans" the tree is caught). Content oids come from ONE batched
 * `git hash-object --stdin-paths` call, so file bytes stream through git instead of being read
 * into Node memory one `readFileSync` at a time (per-file fallback only for newline paths).
 * Ignored paths (node_modules/, dist/, .env per .gitignore) are outside the mandate boundary by
 * design: they are build/tool artifacts, and hashing them would make every review O(node_modules).
 */
export function snapshotWorktree(cwd: string): WorktreeSnapshot {
  try {
    gitOut(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { git: false, hash: null };
  }
  try {
    const h = createHash('sha256');
    let head = '';
    try { head = gitOut(cwd, ['rev-parse', 'HEAD']).trim(); } catch { head = '(no HEAD)'; } // fresh repo, no commits
    h.update('HEAD=').update(head).update('\n');
    // The index: staged mode+oid per path — catches `git add` / `git reset` with no byte changes.
    let index = '';
    try { index = gitOut(cwd, ['ls-files', '--stage']); } catch { index = ''; } // fresh repo
    h.update('INDEX=').update(index).update('\n');
    const list = gitOut(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = list.split('\0').filter(Boolean).sort();
    const files: Array<{ rel: string; size: number; mode: number }> = [];
    for (const rel of paths) {
      let st;
      try { st = statSync(join(cwd, rel)); } catch { h.update(rel).update('=<missing>\n'); continue; } // deleted tracked file
      if (st.isDirectory()) continue; // submodule dir etc.
      files.push({ rel, size: st.size, mode: st.mode & 0o7777 });
    }
    const oids = hashFileBatch(cwd, files.map((f) => f.rel));
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      h.update(f.rel).update('=').update((f.mode).toString(8)).update(':').update(String(f.size)).update(':').update(oids[i]).update('\n');
    }
    let stash = '';
    try { stash = gitOut(cwd, ['stash', 'list']); } catch { stash = ''; }
    h.update('STASH=').update(stash);
    return { git: true, hash: h.digest('hex') };
  } catch (err) {
    return { git: true, hash: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Blob oids for many files in one streaming `git hash-object` call (LF-separated stdin paths);
 *  a path containing a newline falls back to hashing that file's bytes in-process. */
function hashFileBatch(cwd: string, rels: string[]): string[] {
  const safe = rels.filter((r) => !r.includes('\n'));
  const oidBySafe = new Map<string, string>();
  if (safe.length) {
    const out = execFileSync('git', ['hash-object', '--stdin-paths'], {
      cwd, encoding: 'utf8', input: safe.join('\n') + '\n',
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    const lines = out.trim().split('\n');
    safe.forEach((r, i) => oidBySafe.set(r, lines[i] ?? '<no-oid>'));
  }
  return rels.map((r) => oidBySafe.get(r)
    ?? createHash('sha256').update(readFileSync(join(cwd, r))).digest('hex'));
}

/**
 * true = untouched, false = the worktree changed (or the after-snapshot could not be taken — a
 * reviewer that broke `git` in a repo that worked before is a violation, not "unknown"),
 * null = cannot judge (not a git repo).
 */
export function sameSnapshot(before: WorktreeSnapshot, after: WorktreeSnapshot): boolean | null {
  if (!before.git) return null;
  if (before.hash === null) return null; // could not read it before the run either — unknown
  if (!after.git || after.hash === null) return false;
  return before.hash === after.hash;
}

/**
 * The diff itself, embedded for reviewers that CANNOT run git (claude read-only workers: their
 * `--tools Read Grep Glob` set has no Bash — see src/adapters/claude.ts). Output is size-capped so
 * argv stays far under ARG_MAX; the reviewer is told to Read the files for anything truncated.
 * Falls back to the run-it-yourself instruction when git fails (bad ref / not a repo).
 */
export function embeddedDiff(cwd: string, diffBase: string, maxBytes = 65_536): string {
  try {
    const log = gitOut(cwd, ['log', `${diffBase}..HEAD`, '--oneline']);
    let diff = gitOut(cwd, ['diff', `${diffBase}...HEAD`]);
    let note = '';
    if (diff.length > maxBytes) {
      diff = diff.slice(0, maxBytes);
      note = `\n[diff truncated at ${maxBytes} bytes — read the files with Read/Grep for the rest]`;
    }
    return 'Review the changes on this branch relative to `' + diffBase + '`. You cannot run shell ' +
      'commands; the diff is embedded below — read the surrounding code with Read/Grep/Glob as ' +
      'needed. Do not modify anything.\n\n' +
      'Commits (git log ' + diffBase + '..HEAD --oneline):\n' + log +
      '\nDiff (git diff ' + diffBase + '...HEAD):\n```diff\n' + diff + '\n```' + note + '\n\n';
  } catch {
    return diffInstruction(diffBase);
  }
}

/** The instruction heddle prepends when the caller supplies `diff_base` (a git ref). */
export function diffInstruction(diffBase: string): string {
  return 'Review the changes on this branch relative to `' + diffBase + '`: run `git diff ' + diffBase +
    '...HEAD` (and `git log ' + diffBase + '..HEAD --oneline`) in the working directory to see exactly ' +
    'what changed, then read the surrounding code as needed. Do not modify anything.\n\n';
}
