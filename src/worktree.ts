import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Worktree confinement (HED-98).
 *
 * Maya's layout puts agent worktrees INSIDE the repo (`<repo>/.worktrees/<agent>`), and a linked
 * worktree's `.git` is a FILE pointing at the parent. Any worker that resolves "the project root"
 * by walking up therefore lands in the CANONICAL checkout — observed live 2026-08-16: an agy docs
 * worker dispatched with cwd `<repo>/.worktrees/agentv` wrote its edit into `<repo>/docs/COMMS.md`,
 * leaving shared main dirty.
 *
 * heddle cannot PREVENT this at the CLI layer — no provider offers a verified write-confinement
 * flag (codex's `--sandbox workspace-write` is the closest; agy's `--sandbox` documents only
 * "terminal restrictions" and has NOT been tested for file writes, so heddle does not claim it).
 * So the guarantee here is DETECTION, which needs no provider cooperation.
 *
 * The fingerprint must survive an ESCAPED AGENT, not just a clumsy one, so it covers the three ways
 * a naive `git status` comparison is blind (all found in PR #28 review):
 *   - HEAD: an escaped worker that COMMITS its parent edits leaves status clean;
 *   - content hashes of dirty paths: a file already ` M` before the run stays ` M` after further
 *     edits, so status letters alone miss it;
 *   - both-direction comparison: a path that DISAPPEARS (deleted, or reverted to clean) never
 *     shows up when only the after-state is walked.
 * Ignored paths stay outside the boundary by design (same rule as the HED-3 read-only mandate:
 * they are build/tool artifacts, and hashing them would make every dispatch O(node_modules)).
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  });
}

export interface WorktreeContext {
  /** The canonical (main) checkout this linked worktree belongs to. */
  parentRoot: string;
  /** The linked worktree's own root — what the worker should treat as its project root. */
  worktreeRoot: string;
}

/**
 * The canonical checkout when `cwd` is inside a LINKED worktree, else null (a normal checkout, or
 * not a repo — nothing to confine against in either case).
 *
 * Uses `git worktree list --porcelain`, whose FIRST entry is always the main worktree. That is
 * correct for repos created with `--separate-git-dir` (where the common dir is not
 * `<checkout>/.git`, so deriving the root from it is wrong) and avoids `--path-format`, which
 * needs git >= 2.31 and would otherwise silently disable confinement on older git.
 */
export function parentCheckoutOf(cwd: string): WorktreeContext | null {
  try {
    const worktreeRoot = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    if (!worktreeRoot) return null;
    const listed = git(cwd, ['worktree', 'list', '--porcelain']);
    const first = listed.split('\n').find((l) => l.startsWith('worktree '));
    if (!first) return null;
    const parentRoot = first.slice('worktree '.length).trim();
    if (!parentRoot || parentRoot === worktreeRoot) return null; // we ARE the main worktree
    return { parentRoot, worktreeRoot };
  } catch {
    return null; // not a git dir, or git unavailable — no confinement claim is made
  }
}

/** HEAD + every dirty path's status AND content digest. */
export interface CheckoutFingerprint {
  head: string;
  /** path → "<XY>:<content digest>" ('<missing>' when the path is gone, e.g. a staged deletion). */
  entries: Map<string, string>;
}

/** Fingerprint a checkout; null when it cannot be read (no claim is then made in either direction). */
export function checkoutFingerprint(root: string): CheckoutFingerprint | null {
  try {
    let head = '(no HEAD)';
    try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch { /* fresh repo, no commits */ }
    // -z: NUL-separated records, so paths with spaces/newlines/quotes parse correctly.
    // -uall lists untracked FILES individually. Without it git collapses an untracked directory to
    // a single `dir/` entry, so deleting one file inside pre-existing untracked work would leave the
    // entry unchanged and the loss invisible (PR #40, codex-connector). Ignored paths are still
    // excluded, so this does not walk node_modules.
    const raw = git(root, ['status', '--porcelain', '-z', '-uall']);
    const entries = new Map<string, string>();
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.length < 4) continue; // "XY path" is at least 4 chars; trailing empty record
      const status = rec.slice(0, 2);
      const path = rec.slice(3);
      // A rename/copy is ONE entry spanning TWO NUL-separated fields: "R  <new>\0<old>\0". The old
      // path has no XY prefix, so parsing it as its own record yields a garbage entry (PR #28,
      // gitar — verified: `git mv a.txt b.txt` emits `R  b.txt\0a.txt\0`). Consume it here.
      if (status[0] === 'R' || status[0] === 'C') {
        const from = records[i + 1];
        i += 1;
        entries.set(path, `${status}:from=${from ?? '?'}`);
        continue;
      }
      let digest = '<missing>';
      try { digest = createHash('sha256').update(readFileSync(join(root, path))).digest('hex').slice(0, 16); }
      catch { /* deleted, or a directory — the status letters still carry the change */ }
      entries.set(path, `${status}:${digest}`);
    }
    return { head, entries };
  } catch {
    return null;
  }
}

/**
 * What changed in the parent between the two fingerprints: HEAD movement, paths that appeared or
 * changed (status OR content), and paths that DISAPPEARED. Empty = nothing detected; null =
 * undecidable (a fingerprint was unavailable), which is never reported as clean.
 */
export function escapedPaths(
  before: CheckoutFingerprint | null, after: CheckoutFingerprint | null,
): string[] | null {
  if (before === null || after === null) return null;
  const out: string[] = [];
  if (before.head !== after.head) out.push(`HEAD moved ${before.head.slice(0, 8)} → ${after.head.slice(0, 8)}`);
  for (const [path, state] of after.entries) {
    if (before.entries.get(path) !== state) out.push(`${state.slice(0, 2).trim() || '??'} ${path}`);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) out.push(`cleared ${path}`); // deleted, or reverted to clean
  }
  return out.sort();
}

/**
 * Work that EXISTED in the worker's own cwd before the dispatch and is GONE afterwards (HED-127).
 *
 * A worker is free to create and modify inside its own worktree — that is the job — so this
 * reports only DESTRUCTION: a path that was dirty (modified or untracked) before the run and is now
 * clean or missing, or a HEAD that moved. That is the signature of a working-tree reset, which
 * silently discards the orchestrator's uncommitted work with no stash and no reflog to recover from.
 *
 * Not hypothetical: 2026-08-17, ledger #98 — a docs worker reverted two modified files and deleted
 * an untracked one before starting its own task, leaving no trace of what it ran.
 *
 * Additions and further edits are deliberately NOT reported; only losses.
 */
export function destroyedWork(
  before: CheckoutFingerprint | null, after: CheckoutFingerprint | null,
): string[] | null {
  if (before === null || after === null) return null;
  const lost: string[] = [];
  for (const [path, state] of before.entries) {
    const now = after.entries.get(path);
    if (now === undefined) {
      lost.push(`reverted-or-deleted ${path}`);
    } else if (now.slice(0, 2).includes('D')) {
      // The path is still listed, but as a DELETION — a tracked file the orchestrator had modified
      // is now gone. Unambiguous destruction, and it survives the vanish check above because git
      // still reports the path (PR #40, codacy + gitar).
      lost.push(`deleted ${path}`);
    } else if (state.startsWith('??') && !now.startsWith('??')) {
      // An untracked file the orchestrator was holding is no longer untracked — the worker staged
      // or committed it. Not destroyed on disk, but no longer the orchestrator's to discard freely.
      lost.push(`untracked file taken over ${path}`);
    }
    // NOT reported: a still-dirty path whose CONTENT changed. A worker editing files in its own cwd
    // is the job, and an edit is indistinguishable from an overwrite from out here — flagging it
    // would fire on nearly every legitimate dispatch, and a warning that cries wolf gets ignored,
    // which costs more than the case it catches. Stated as a known limit rather than papered over.
  }
  if (before.head !== after.head) lost.push(`HEAD moved ${before.head.slice(0, 8)} → ${after.head.slice(0, 8)}`);
  return lost.sort();
}
