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
 *    cursor/agy have none, so heddle proves the mandate structurally: hash `git status --porcelain`
 *    + `git diff HEAD` (+ untracked file list) before and after the run. A changed worktree is a
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

export function pickReviewer(route: Route, authorProviderRaw: string | undefined): ReviewerPick | null {
  const authorProvider = normalizeProvider(authorProviderRaw);
  if (!authorProvider) return null;
  if (route.provider !== authorProvider) return null;
  const pool = route.reviewerPool ?? [];
  const idx = pool.findIndex((e) => e.provider !== authorProvider);
  if (idx < 0) {
    throw new Error(
      `task class "${route.taskClass}": the author's provider is "${authorProvider}" and every reviewer_pool entry ` +
      `${pool.length ? `(${pool.map((e) => e.provider).join(', ')}) ` : ''}is the same provider — an adversarial ` +
      `reviewer must be a different model family; add a different provider to reviewer_pool in routing.v0.yaml.`,
    );
  }
  return { provider: pool[idx].provider, model: pool[idx].model, reason: `pool:${idx + 1} (author is ${authorProvider})` };
}

export interface WorktreeSnapshot {
  /** false when cwd is not inside a git repo (the mandate check is then unavailable, not failed). */
  git: boolean;
  /** sha256 over HEAD + every non-ignored file's path+size+content hash + the stash list. */
  hash: string | null;
  /** Set when a git call failed AFTER the repo was recognized — judged as a violation, not unknown. */
  error?: string;
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * CONTENT digest of the worktree: HEAD (a commit/amend/stash-pop moves it), every tracked and
 * untracked non-ignored file (path + size + sha256 of bytes — a rewrite that keeps the file list
 * unchanged is caught), and the stash list (a `git stash` that "cleans" the tree is caught).
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
    const list = gitOut(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = list.split('\0').filter(Boolean).sort();
    for (const rel of paths) {
      const abs = join(cwd, rel);
      let st;
      try { st = statSync(abs); } catch { h.update(rel).update('=<missing>\n'); continue; } // deleted tracked file
      if (st.isDirectory()) continue; // submodule dir etc.
      const fh = createHash('sha256').update(readFileSync(abs)).digest('hex');
      h.update(rel).update('=').update(String(st.size)).update(':').update(fh).update('\n');
    }
    let stash = '';
    try { stash = gitOut(cwd, ['stash', 'list']); } catch { stash = ''; }
    h.update('STASH=').update(stash);
    return { git: true, hash: h.digest('hex') };
  } catch (err) {
    return { git: true, hash: null, error: err instanceof Error ? err.message : String(err) };
  }
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

/** The instruction heddle prepends when the caller supplies `diff_base` (a git ref). */
export function diffInstruction(diffBase: string): string {
  return 'Review the changes on this branch relative to `' + diffBase + '`: run `git diff ' + diffBase +
    '...HEAD` (and `git log ' + diffBase + '..HEAD --oneline`) in the working directory to see exactly ' +
    'what changed, then read the surrounding code as needed. Do not modify anything.\n\n';
}
