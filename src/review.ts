import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
export function pickReviewer(route: Route, authorProvider: string | undefined): ReviewerPick | null {
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
  hash: string | null;
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
}

/** Content hash of everything a worker could have changed: tracked diffs vs HEAD + the untracked list. */
export function snapshotWorktree(cwd: string): WorktreeSnapshot {
  try {
    gitOut(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { git: false, hash: null };
  }
  try {
    const status = gitOut(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
    const diff = gitOut(cwd, ['diff', 'HEAD', '--no-color']);
    const h = createHash('sha256').update(status).update(' ').update(diff).digest('hex');
    return { git: true, hash: h };
  } catch {
    return { git: false, hash: null };
  }
}

/** true = untouched, false = the worktree changed, null = cannot judge (not a git repo). */
export function sameSnapshot(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean | null {
  if (!a.git || !b.git) return null;
  return a.hash === b.hash;
}

/** The instruction heddle prepends when the caller supplies `diff_base` (a git ref). */
export function diffInstruction(diffBase: string): string {
  return 'Review the changes on this branch relative to `' + diffBase + '`: run `git diff ' + diffBase +
    '...HEAD` (and `git log ' + diffBase + '..HEAD --oneline`) in the working directory to see exactly ' +
    'what changed, then read the surrounding code as needed. Do not modify anything.\n\n';
}
