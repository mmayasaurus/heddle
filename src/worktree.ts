import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolRuntimePath } from './tool-runtime.js';

/**
 * Worktree confinement (HED-98).
 *
 * The fleet layout puts agent worktrees INSIDE the repo (`<repo>/.worktrees/<agent>`), and a linked
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

/**
 * Environment variables through which git ignores the working directory or its own config files:
 * GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY redirect every
 * command here to whatever repository they name, and the config-injection channel —
 * GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS, GIT_CONFIG(_GLOBAL/_SYSTEM) —
 * can plant `remote.origin.url` or `core.worktree` without touching any file. An orchestrator
 * process inherits them (a git hook exports GIT_DIR), and everything in this module reasons about
 * the WORKER'S CWD — its identity, its quality gate, its confinement — so they are stripped once,
 * for every consumer (HED-389 review rounds 1 #1 and 2 #1).
 */
const GIT_ENV_OVERRIDES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  // Discovery limits: an inherited ceiling below the checkout makes git stop before the root, which
  // drops the gate AND silently disables linked-worktree confinement (codex P2 on PR #95).
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);
const GIT_ENV_OVERRIDE_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!GIT_ENV_OVERRIDES.has(name) && !GIT_ENV_OVERRIDE_RE.test(name)) env[name] = value;
  }
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(),
    timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  });
}

/** Like `git`, but merges extra env AFTER the inherited-override strip (so a temp GIT_INDEX_FILE can be set) and keeps stderr for error reasons. */
function gitWithEnv(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv(), ...extraEnv },
    timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  });
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === 'string' && e.stderr.trim()) return e.stderr.trim();
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  }
  return String(err);
}

function pathStillExists(cwd: string, rel: string): boolean {
  try { lstatSync(join(cwd, rel)); return true; }
  catch { return false; }
}

/** Git repository identity for cwd-based policy decisions; null outside a readable Git repository. */
export interface GitRepository {
  /** The checkout `cwd` is inside — for a LINKED worktree, the worktree's own path. */
  topLevel: string;
  /**
   * The repository's MAIN checkout — the first `git worktree list --porcelain` entry: equal to
   * topLevel in a normal checkout; for a linked worktree, the checkout it was added from, wherever
   * that sits (inside the repo as `<repo>/.worktrees/<agent>`, or beside it as a consumer
   * fleet's sibling `Rebuild-Project-Root.<feature>`). This — not topLevel — is the repository's
   * identity: a real dispatch cwd is a linked worktree whose top level is named after the
   * WORKTREE, not the repo (HED-389 review: keyed on topLevel, heddle dispatches matched nothing).
   * null when the worktree list is unreadable: the identity is then UNKNOWN — consumers make no
   * claim from it (qualityGateForRepository drops the gate, parentCheckoutOf does not confine) and
   * never fall back to the worktree folder name.
   */
  mainRoot: string | null;
  originUrl: string | null;
}

/**
 * Resolve a cwd to its Git top level, its repository's main checkout and, when configured, its
 * origin URL. Consumers key repository identity on the main checkout and use the remote only for
 * names that are not stable on disk (a workspace clone under a different folder name).
 *
 * The main checkout is the FIRST entry of `git worktree list --porcelain`, which is always the main
 * worktree. That is correct for repos created with `--separate-git-dir` (where the common dir is not
 * `<checkout>/.git`, so deriving the root from `--git-common-dir` is wrong) and avoids
 * `--path-format`, which needs git >= 2.31 and would otherwise silently disable confinement on
 * older git.
 */
export function gitRepositoryFor(cwd: string): GitRepository | null {
  try {
    const topLevel = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    if (!topLevel) return null;
    let mainRoot: string | null = null;
    try {
      const first = git(cwd, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '));
      mainRoot = first ? first.slice('worktree '.length).trim() || null : null;
    } catch { /* unlistable — identity unknown; consumers treat null as "no claim", never as topLevel */ }
    let originUrl: string | null = null;
    // --local: the repository's own config file only (shared by its linked worktrees) — never a
    // global/system file or an env-injected value, which could name a repository this is not.
    try { originUrl = git(cwd, ['config', '--local', '--get', 'remote.origin.url']).trim() || null; }
    catch { /* no origin is normal for a local checkout */ }
    return { topLevel, mainRoot, originUrl };
  } catch {
    return null;
  }
}

export interface WorktreeContext {
  /** The canonical (main) checkout this linked worktree belongs to. */
  parentRoot: string;
  /** The linked worktree's own root — what the worker should treat as its project root. */
  worktreeRoot: string;
}

/**
 * The canonical checkout when `cwd` is inside a LINKED worktree, else null (a normal checkout, or
 * not a repo — nothing to confine against in either case). The main-worktree resolution itself
 * lives in gitRepositoryFor (see there for why `git worktree list`, not `--git-common-dir`).
 */
export function parentCheckoutOf(cwd: string): WorktreeContext | null {
  try {
    const repo = gitRepositoryFor(cwd);
    // Null when not a repo, when the worktree list is unreadable, or when we ARE the main worktree.
    if (!repo?.mainRoot || repo.mainRoot === repo.topLevel) return null;
    return { parentRoot: repo.mainRoot, worktreeRoot: repo.topLevel };
  } catch {
    return null; // not a git dir, or git unavailable — no confinement claim is made
  }
}

/** HEAD + every dirty path's status AND content digest. */
export interface CheckoutFingerprint {
  head: string;
  /** path → "<XY>:<content digest>" — a sha256 prefix, or '<missing>' (gone), 'symlink:<hash>' (link target text, not followed), '<special>' (FIFO/socket/device/dir), or '<large:bytes:mtimeMs:ctimeMs>' (over the hash cap). */
  entries: Map<string, string>;
}

/**
 * Cap the per-path content read (HED-625). checkoutFingerprint hashes every dirty/untracked path; a
 * worker-created FIFO would block readFileSync on the event loop forever (a pipe with no writer never
 * returns), and a multi-GB file would spike memory. A path above this size is fingerprinted by its
 * size, mtime and ctime instead of its content — enough for escapedPaths to still catch an in-place
 * rewrite of an already-dirty path (ctime moves and userspace cannot restore it), without reading it.
 */
const MAX_FINGERPRINT_HASH_BYTES = 10 * 1024 * 1024; // 10 MiB

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
        // A rename/copy is ALWAYS a tracked change — git rename-detects only tracked content (an
        // untracked runtime write is a '??' record, excluded below). So it is real and always recorded;
        // suppressing on a runtime destination would let a reviewer hide moving tracked project content
        // into .memdb/.memtrace/.serena (qodo #2). Consume the second NUL field either way.
        const from = records[i + 1];
        i += 1;
        entries.set(path, `${status}:from=${from ?? '?'}`);
        continue;
      }
      if (isToolRuntimePath(path) && status === '??') continue; // untracked tool-runtime churn only; a tracked change here is real (qodo #1)
      let digest = '<missing>';
      try {
        // HED-625: lstat FIRST — never readFileSync a non-regular path. A worker-created FIFO would
        // block the event loop forever (a pipe with no writer never returns), and a huge file would
        // spike memory. lstat (not stat) so a symlink is classified here, never followed to whatever it
        // points at. Each marker still CHANGES when the underlying dirt does, so escapedPaths keeps
        // detecting a retargeted symlink or a rewritten large file at an already-dirty path.
        const fullPath = join(root, path);
        const st = lstatSync(fullPath);
        if (st.isSymbolicLink()) {
          // Hash the link TARGET TEXT — readlink reads the link itself (never opens/follows the
          // target), so no fifo/device hang and a dangling target is fine; only a racing unlink/retype
          // between lstat and readlink throws → fall through to <special>.
          try { digest = `symlink:${createHash('sha256').update(readlinkSync(fullPath)).digest('hex').slice(0, 16)}`; }
          catch { digest = '<special>'; }
        } else if (!st.isFile()) {
          digest = '<special>';                                     // FIFO / socket / device / directory
        } else if (st.size > MAX_FINGERPRINT_HASH_BYTES) {
          // size+mtime+ctime: a same-length rewrite changes mtime, and even a rewrite that RESTORES
          // mtime still moves ctime — which userspace cannot set — so escapedPaths still sees it.
          digest = `<large:${st.size}:${Math.trunc(st.mtimeMs)}:${Math.trunc(st.ctimeMs)}>`;
        } else {
          digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex').slice(0, 16);
        }
      }
      catch { /* deleted, or unreadable — the status letters still carry the change */ }
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
 * Block a fallback from inheriting checkout dirt created by a failed dispatch leg: any dirt that
 * appeared since `preFp` — a new/changed/cleared path, or a moved HEAD — blocks the re-dispatch. A
 * clean tree passes, and a checkout that was non-git before the leg (preFp null) passes: there is
 * nothing to protect, matching escapedPaths. But a checkout that WAS readable and is now unreadable
 * (postFp null with a non-null preFp — e.g. the leg destroyed `.git`) is the ultimate dirt and
 * blocks: `escapedPaths` reports that as "undecidable" (null), which must never pass a wrecked tree.
 *
 * Refuse-with-report by default. Opt-in recovery that auto-commits isolable new paths lives in
 * `autoWipCommit` (HED-622): a naive git add/commit cannot isolate one leg's contribution at path
 * granularity, so recovery is membership-guarded and temp-index-only; when isolation is undecidable
 * this barrier still refuses.
 */
export function fallbackBarrier(
  cwd: string, preFp: CheckoutFingerprint | null,
): { blocked: boolean; dirt: string[] | null } {
  const postFp = checkoutFingerprint(cwd);
  if (preFp !== null && postFp === null) {
    return { blocked: true, dirt: ['checkout unreadable after the leg ran (git repository destroyed or inaccessible)'] };
  }
  const dirt = escapedPaths(preFp, postFp);
  if (dirt === null || dirt.length === 0) return { blocked: false, dirt };
  return { blocked: true, dirt };
}

const AUTO_WIP_MESSAGE = 'heddle auto-wip: isolate failed-leg new paths';

/**
 * Opt-in path-scoped auto-WIP of a failed leg's newly-created paths (HED-622).
 *
 * Commits ONLY paths present in `postFp` and absent from `preFp` that are newly-created UNTRACKED
 * files ('??'), and only when HEAD is unchanged and every pre-existing dirty path is byte-identical.
 * A leg that touched an established TRACKED file (modify/delete/rename) makes the whole operation
 * unsafe → refuse (codex finding 2: checkoutFingerprint omits clean tracked files, so such a change
 * ALSO lands in postFp∖preFp — and committing a change to project content is exactly what this
 * barrier must never do). Staging is isolated in a temporary index; the real `.git/index` is written
 * only once, and only to reconcile the leg's OWN committed paths to the new HEAD so they are not left
 * staged-for-deletion (codex finding 3) — orchestrator index entries are never touched. HEAD is
 * pinned to a captured value and moved via compare-and-swap, so a concurrent HEAD advance refuses
 * instead of being reverted (codex finding 1). Any doubt — missing fingerprints, mixed dirt, a moved
 * HEAD, vanished-all, or any git failure — refuses.
 */
export function autoWipCommit(
  cwd: string, preFp: CheckoutFingerprint | null, postFp: CheckoutFingerprint | null,
): { committed: true; newFp: CheckoutFingerprint } | { committed: false; reason: string } {
  if (preFp === null || postFp === null) {
    return { committed: false, reason: 'undecidable: missing pre or post fingerprint' };
  }

  const unsafe: string[] = [];
  if (postFp.head !== preFp.head) {
    unsafe.push(`HEAD moved ${preFp.head.slice(0, 8)} → ${postFp.head.slice(0, 8)}`);
  }
  const changed: string[] = [];
  const cleared: string[] = [];
  for (const [path, state] of preFp.entries) {
    const now = postFp.entries.get(path);
    if (now === undefined) cleared.push(path);
    else if (now !== state) changed.push(path);
  }
  if (changed.length) unsafe.push(`pre-existing dirty path changed: ${changed.join(', ')}`);
  if (cleared.length) unsafe.push(`pre-existing dirty path cleared: ${cleared.join(', ')}`);
  if (unsafe.length) return { committed: false, reason: unsafe.join('; ') };

  // Membership guard (codex adversarial finding 2): a path absent from preFp is safe to auto-commit
  // ONLY when it is a newly-created UNTRACKED file (git status '??'). checkoutFingerprint omits CLEAN
  // tracked files, so a leg that MODIFIES (' M'), DELETES (' D'), or RENAMES ('R…') a clean tracked
  // file ALSO produces a postFp∖preFp path; committing it would commit a change to an established
  // project file. Any such path makes the whole operation UNSAFE (refuse), never merely skipped — the
  // tree is entangled with real project changes that cannot be isolated at path granularity.
  const safeSet: string[] = [];
  const trackedTouched: string[] = [];
  for (const [path, marker] of postFp.entries) {
    if (preFp.entries.has(path)) continue;
    if (marker.startsWith('??')) safeSet.push(path);
    else trackedTouched.push(`${marker.slice(0, 2).trim() || '??'} ${path}`);
  }
  if (trackedTouched.length) {
    return { committed: false, reason: `leg changed pre-existing tracked path(s): ${trackedTouched.join(', ')}` };
  }
  if (safeSet.length === 0) {
    return { committed: false, reason: 'no isolable new paths (safeSet empty)' };
  }

  // Pin every HEAD reference to one captured value (codex finding 1). commit-tree re-resolving HEAD
  // plus an unconditional update-ref would clobber a HEAD that advanced concurrently: the new tree is
  // built from oldHead but the ref would move regardless, reverting whatever landed in between. Capture
  // oldHead, parent and read-tree on it, and move HEAD via compare-and-swap. The pre-check closes the
  // window between the caller's postFp and here; the CAS closes the window between here and update-ref.
  let oldHead: string;
  try {
    oldHead = gitWithEnv(cwd, ['rev-parse', 'HEAD']).trim();
  } catch (err) {
    return { committed: false, reason: `no HEAD to commit onto: ${gitErrorMessage(err)}` };
  }
  if (oldHead !== postFp.head) {
    return { committed: false, reason: `HEAD moved after fingerprint (${postFp.head.slice(0, 8)} → ${oldHead.slice(0, 8)})` };
  }

  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'heddle-autowip-'));
    const indexFile = join(tmpDir, 'index');
    const pathspecFile = join(tmpDir, 'pathspec');
    const indexEnv: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: indexFile,
      GIT_LITERAL_PATHSPECS: '1',
    };

    gitWithEnv(cwd, ['read-tree', oldHead], indexEnv);

    const existing = safeSet.filter((p) => pathStillExists(cwd, p));
    if (existing.length === 0) {
      return { committed: false, reason: 'all isolable paths vanished before staging' };
    }

    writeFileSync(pathspecFile, existing.join('\0') + '\0');
    gitWithEnv(cwd, [
      'add', '--ignore-errors',
      `--pathspec-from-file=${pathspecFile}`,
      '--pathspec-file-nul',
    ], indexEnv);

    const tree = gitWithEnv(cwd, ['write-tree'], indexEnv).trim();
    let headTree: string;
    try {
      headTree = gitWithEnv(cwd, ['rev-parse', `${oldHead}^{tree}`]).trim();
    } catch (err) {
      return { committed: false, reason: `could not resolve HEAD tree: ${gitErrorMessage(err)}` };
    }
    if (tree === headTree) {
      return { committed: false, reason: 'all isolable paths vanished before staging' };
    }

    const commitSha = gitWithEnv(cwd, ['commit-tree', tree, '-p', oldHead, '-m', AUTO_WIP_MESSAGE]).trim();
    // Compare-and-swap: refuse (leaving a dangling, GC-safe commit) if HEAD advanced past oldHead.
    try {
      gitWithEnv(cwd, ['update-ref', 'HEAD', commitSha, oldHead]);
    } catch (err) {
      return { committed: false, reason: `HEAD advanced during auto-WIP; refused to overwrite it: ${gitErrorMessage(err)}` };
    }

    // Reconcile ONLY the committed paths into the REAL index (codex finding 3). update-ref moved HEAD
    // while the real index stayed seeded from oldHead, so those paths now read as staged-for-deletion
    // against the new HEAD — a later real-index commit would delete the just-committed work, and the
    // phantom deletion even hides under a '??' in the fingerprint we return (git lists the path both
    // ways; the Map keeps the last). `git reset -- <paths>` copies the new HEAD's entries for EXACTLY
    // those paths; the orchestrator's own index entries stay put. This is a deliberate, minimal
    // departure from the temp-index-only route (R's amendment #1): the real index is written, but only
    // to reconcile the leg's OWN committed paths, never an orchestrator entry. GIT_LITERAL_PATHSPECS
    // only — NOT indexEnv — so this hits the real .git/index, not the (now-deleted) temp index.
    try {
      gitWithEnv(cwd, [
        'reset', '-q',
        `--pathspec-from-file=${pathspecFile}`,
        '--pathspec-file-nul',
      ], { GIT_LITERAL_PATHSPECS: '1' });
    } catch (err) {
      // The reset failed AFTER update-ref moved HEAD — most reachably because another process holds
      // .git/index.lock (memtrace watchers / Verity hooks touch the index in this fleet). A failed
      // reset writes nothing (git takes index.lock then renames; a lock-acquire failure leaves the
      // real index untouched), so roll HEAD back to oldHead via compare-and-swap: the tree is then
      // EXACTLY as found and committed:false is fully honest — the caller refuses the fallback and the
      // worktree is unchanged. update-ref does not take index.lock, so the rollback succeeds precisely
      // when the reset failed for that reason (codex round-2 finding B). A rollback that itself fails
      // (HEAD moved past our commit) leaves the auto-WIP commit on HEAD and says so.
      const resetErr = gitErrorMessage(err);
      try {
        gitWithEnv(cwd, ['update-ref', 'HEAD', oldHead, commitSha]);
        return { committed: false, reason: `could not reconcile the real index; rolled HEAD back to the tree as found: ${resetErr}` };
      } catch (rollbackErr) {
        // The CAS rollback failed because HEAD is no longer our commit — another process advanced it,
        // so HEAD holds THAT commit, not necessarily ours (codex pass-3 accuracy nit). Do not claim
        // which commit HEAD holds; point to manual resolution.
        return { committed: false, reason: `could not reconcile the real index and could not roll back — HEAD advanced past the auto-WIP commit ${commitSha.slice(0, 8)} concurrently; resolve manually: ${resetErr}; rollback: ${gitErrorMessage(rollbackErr)}` };
      }
    }

    // A fingerprint that is unreadable HERE (after a SUCCESSFUL reset) leaves a good tree we simply
    // cannot read — do NOT roll back; refuse honestly (codex round-2 finding B, B2 half).
    const newFp = checkoutFingerprint(cwd);
    if (newFp === null) {
      return { committed: false, reason: 'auto-WIP updated HEAD and reconciled the index, but the checkout fingerprint is now unreadable' };
    }
    return { committed: true, newFp };
  } catch (err) {
    return { committed: false, reason: gitErrorMessage(err) };
  } finally {
    if (tmpDir !== undefined) {
      try { rmSync(tmpDir, { recursive: true, force: true }); }
      catch { /* temp cleanup is best-effort; only the leg's own committed paths were written to the real index */ }
    }
  }
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
