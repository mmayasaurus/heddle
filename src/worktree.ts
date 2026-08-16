import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

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
 * So the guarantee here is DETECTION, which needs no provider cooperation: fingerprint the parent
 * checkout around the dispatch and name whatever changed.
 *
 * Detection is exact and cheap (verified 2026-08-16):
 *   - a linked worktree has `git rev-parse --git-dir` != `--git-common-dir`;
 *   - the canonical checkout root is `dirname(common-dir)`.
 * One `git status --porcelain` per side is the whole cost.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * The canonical checkout root when `cwd` is inside a LINKED worktree, else null (a normal
 * checkout, or not a repo at all — nothing to confine against in either case).
 */
export function parentCheckoutOf(cwd: string): string | null {
  try {
    const gitDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']).trim();
    const commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!gitDir || !commonDir || gitDir === commonDir) return null; // not a linked worktree
    const parent = dirname(commonDir);
    return parent && parent !== cwd ? parent : null;
  } catch {
    return null; // not a git dir, or git unavailable — no confinement claim is made
  }
}

/** Porcelain state of a checkout; null when it cannot be read (no claim is then made either way). */
export function checkoutFingerprint(root: string): string | null {
  try {
    return git(root, ['status', '--porcelain']);
  } catch {
    return null;
  }
}

/**
 * Paths that appeared or changed in the parent between the two fingerprints. Empty = no escape
 * detected; null = undecidable (a fingerprint was unavailable), which is never reported as clean.
 */
export function escapedPaths(before: string | null, after: string | null): string[] | null {
  if (before === null || after === null) return null;
  const parse = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const line of s.split('\n')) {
      if (!line.trim()) continue;
      // porcelain v1: XY<space>path (path may contain " -> " for renames; keep it whole)
      m.set(line.slice(3), line.slice(0, 2));
    }
    return m;
  };
  const b = parse(before);
  const a = parse(after);
  const out: string[] = [];
  for (const [path, status] of a) {
    if (b.get(path) !== status) out.push(`${status.trim()} ${path}`);
  }
  return out.sort();
}
