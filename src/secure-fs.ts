import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Hardened filesystem primitives for credential files and rotation locks (HED-452). Shared + exported
 * so the credential-audit fixes (HED-586 reader, HED-590 writer, HED-591 lock) adopt ONE implementation
 * instead of each re-inventing the checks.
 *
 * CALLER CONTRACT / invariant: these primitives validate the TARGET and its IMMEDIATE PARENT only. The
 * target is checked at the open FD / file level (regular file, owned by the effective uid, not a symlink,
 * no group/other permission for a secret) — that FD-level ownership check is the authoritative cross-uid
 * guard. The immediate parent is checked for being a real directory, not a symlink, and not
 * group/other-WRITABLE; the WRITER additionally requires the parent to be euid-OWNED, because it performs
 * pathname operations (rename) AFTER its checks, which a foreign parent owner could redirect — the reader
 * (all post-check ops are on the open fd) and the lock (its claim is a single atomic link) have no such
 * pathname-redirect surface, so they do not require parent ownership.
 *
 * By DEFAULT they do NOT walk ancestors above the immediate parent: Node exposes no per-component
 * `O_NOFOLLOW`/`openat`/`RESOLVE_NO_SYMLINKS` and this project takes zero native deps, so a symlink or a
 * group/other-writable directory HIGHER in the path (or, for the reader/lock, a foreign-owned immediate
 * parent) is not detected in that mode. Two seams narrow this: `ensureSecureDir` already walks to the
 * deepest existing ancestor when CREATING and validates + force-modes each level it makes; and
 * `ensureSecureDir` accepts an optional `boundary` (a trust root, e.g. the caller's home directory) that
 * extends the STRUCTURAL check up the whole EXISTING ancestor chain to — but excluding — that boundary, in
 * both its fast path and the shared create walk (HED-643, closing the higher-ancestor redirect window). The
 * shared walk (`createSecureDirTree`) carries the `boundary` for `ensureSafeParent` too, though its
 * writer/lock callers do not pass one yet (HED-642). The default (no `boundary`) is acceptable only because every path these guard is
 * heddle-owned under `~/.heddle` or a user-owned profile dir — a same-uid trust domain a cross-uid attacker
 * cannot write to, and a same-uid process already holds the credentials outright. Callers MUST pass paths
 * whose ancestors are user-owned and not group/other-writable.
 * This module is POSIX-only (it relies on `process.geteuid`); `effectiveUid` fails closed with a clear
 * error on a platform without it (e.g. win32) rather than silently degrading.
 */

/** A null-pid lock younger than this may be one caught mid-creation; back off rather than reclaim it. */
const CREATION_GRACE_MS = 2000;

/** Result of attempting to claim a credential-operation lock. */
export interface CredentialLockResult {
  ok: boolean;
  /** The process already holding the lock, when it could be determined. */
  heldBy?: number;
}

/**
 * Atomically write a secret without inheriting permissions from an older, possibly permissive file.
 *
 * The requested modes are validated FIRST: a secret file must not be group/other-READABLE and a parent this
 * function may create must not be group/other-WRITABLE, so a caller `mode`/`dirMode` carrying those bits is
 * rejected rather than silently honored (a permissive umask would otherwise let `{ dirMode: 0o777 }` create
 * a world-writable parent that is never post-validated). The target is validated next (a symlink / non-file
 * / foreign-owned name is refused), THEN the parent: checking the target before the parent keeps BOTH
 * ownership guards seam-testable (a foreign pre-existing target trips the target check; a foreign parent
 * with an absent target trips the parent check). Secret-bearing profile directories can legitimately be
 * 0755, so an existing parent is accepted at that mode — but it must be a euid-owned directory (not a
 * symlink, not group/other-writable) and is never chmodded.
 */
export function secureWriteFile(path: string, content: string, opts: { mode?: number; dirMode?: number; euid?: number } = {}): void {
  // Validate the requested modes BEFORE any filesystem work: a caller-supplied mode is honored only if it
  // preserves the guarantees this primitive exists to provide. Reject (rather than clamp) so a mistaken
  // caller is told, not silently given weaker protection than it asked us to enforce.
  const mode = opts.mode ?? 0o600;
  const dirMode = opts.dirMode ?? 0o700;
  if ((mode & 0o077) !== 0) throw new Error(`refusing to write secret file ${path}: mode 0${mode.toString(8)} would grant group/other access to a secret`);
  if ((dirMode & 0o022) !== 0) throw new Error(`refusing to write secret file ${path}: dirMode 0${dirMode.toString(8)} would create a group/other-writable parent`);

  const euid = effectiveUid(opts.euid);

  try {
    const target = lstatSync(path);
    if (target.isSymbolicLink()) throw new Error(`refusing to write secret file ${path}: target is a symlink`);
    if (!target.isFile()) throw new Error(`refusing to write secret file ${path}: target is not a regular file`);
    if (target.uid !== euid) throw new Error(`refusing to write secret file ${path}: target is not owned by effective uid ${euid}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // The writer performs pathname ops (rename) after its checks, so it requires a euid-OWNED parent: a
  // foreign parent owner could otherwise swap the temp name for a symlink between create and rename.
  // (The reader/lock have no such surface — see the module invariant.)
  ensureSafeParent(dirname(path), dirMode, euid);

  // A random temp name (not a per-process counter) stays unique even across Worker threads that share
  // process.pid; O_EXCL is the real guard, this just avoids a spurious EEXIST between concurrent writers.
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    // O_EXCL create (never clobbers, never follows a symlink at the temp name); write, fchmod and close
    // all act on the OPEN fd, so an explicit chmod cannot be redirected through a swapped symlink and the
    // requested mode is guaranteed against a restrictive umask. rename() then replaces the target NAME
    // atomically without following a symlink at that name.
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    writeFileSync(fd, content, 'utf8');
    fchmodSync(fd, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort: preserve the original failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename already consumed the temporary name; preserve the original write failure.
    }
  }
}

/**
 * Read a secret only after rejecting links, non-files, foreign-owned files, and permissive modes.
 * Returning an empty value on a violation would make a credential failure look like an absent secret,
 * so callers receive a descriptive error instead. An absent file is NOT a violation: its natural ENOENT
 * bubbles unchanged so a caller can probe for a not-yet-created secret without unwrapping a security error.
 *
 * The final component is opened `O_NOFOLLOW` and every check runs against the OPEN fd (fstat + read from
 * the fd), so nothing re-resolves the path after the checks — closing the check-then-read TOCTOU a
 * path-based `lstat()`+`readFileSync()` leaves. The immediate parent is validated too (symlink / non-dir
 * / group-or-other-writable); deeper ancestors are the caller's responsibility (see the module invariant).
 */
export function secureReadFile(path: string, opts: { euid?: number } = {}): string {
  const euid = effectiveUid(opts.euid);
  try {
    assertSafeExistingDir(dirname(path));
  } catch (err) {
    // An absent parent is a normal not-found — let the O_NOFOLLOW open below surface ENOENT rather than
    // dressing it up as an attack. A symlinked / non-dir / group-or-other-writable parent IS an attack
    // surface → propagate the refusal (its message names the specific reason).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`refusing to read secret file ${path}: target is a symlink`);
    if (code === 'ENOENT') throw err; // absent secret → natural not-found, per the module contract
    throw new Error(`refusing to read secret file ${path}: could not securely open it`, { cause: err });
  }
  try {
    const target = fstatSync(fd);
    if (!target.isFile()) throw new Error(`refusing to read secret file ${path}: target is not a regular file`);
    if (target.uid !== euid) throw new Error(`refusing to read secret file ${path}: target is not owned by effective uid ${euid}`);
    if ((target.mode & 0o077) !== 0) throw new Error(`refusing to read secret file ${path}: group or other permissions are present`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Ensure a directory exists and is safe to hold credentials: accept an existing one only if it is a
 * euid-owned real directory that is not a symlink and not group/other-writable, or CREATE it (and any
 * missing ancestors) at exactly `mode` when absent. The directory analogue of `secureWriteFile` for the
 * HED-586/590/591 F-cluster — e.g. the native account config directory the CLI later writes
 * `.credentials.json` into — so all three adopt ONE validated create-or-validate path instead of each
 * hand-rolling `lstat` checks.
 *
 * `mode` is validated first: a credential directory must be owner-rwx (so it can actually be entered and
 * written) AND must NOT be group/other-writable, so a `mode` missing an owner bit (e.g. 0o600 — an
 * un-enterable directory) or carrying 0o022 is rejected rather than silently honored.
 *
 * When the directory is ABSENT it is built by `createSecureDirTree` — a validated per-level walk, NOT a
 * single recursive `mkdir` (see that helper for why a umask stripping owner-execute makes the walk
 * necessary, and for the intermediate-trust rule the climb uses). An EXISTING directory is validated but
 * never chmodded (a legitimate 0755 profile dir is accepted, exactly as the writer accepts a 0755 parent).
 */
export function ensureSecureDir(dir: string, opts: { mode?: number; euid?: number; boundary?: string } = {}): void {
  const mode = opts.mode ?? 0o700;
  if ((mode & 0o700) !== 0o700 || (mode & 0o022) !== 0) {
    throw new Error(`refusing to create credential directory ${dir}: mode 0${mode.toString(8)} must be owner-rwx (0o700) and not group/other-writable`);
  }
  const euid = effectiveUid(opts.euid);
  // HED-643: an optional trust root. When given, EVERY existing ancestor from the immediate parent up to
  // (but excluding) `boundary` is validated structurally, closing the redirect vector where a symlinked or
  // group/other-writable ancestor ABOVE the immediate parent could relocate the credential directory. It
  // must be a strict ancestor of `dir` (otherwise the walk would climb past the intended trust root and
  // into the operator/OS domain); absent → the immediate-parent-only contract (HED-634) is unchanged.
  // Normalize the boundary ONCE with resolve() — lexical only (it collapses `.`/`..`/trailing slashes and
  // makes the path absolute WITHOUT touching the filesystem, so symlink component names are preserved for
  // the lstat checks). Comparing resolved paths throughout means a trailing-slash or dot-aliased `boundary`
  // (e.g. `home + "/"`) still stops the walk exactly at the trust root rather than being passed and climbing
  // into the operator/OS domain (qodo correctness finding on #234).
  const boundary = opts.boundary === undefined ? undefined : resolve(opts.boundary);
  if (boundary !== undefined && !isStrictlyWithin(resolve(dir), boundary)) {
    throw new Error(`refusing to create credential directory ${dir}: boundary ${opts.boundary} is not an ancestor of it`);
  }
  // A `..` segment in the target would let the LEXICAL containment check (resolve()) collapse `link/..`,
  // while the OS resolves the `link` symlink FIRST and only then applies `..` — so `mkdirSync` could create
  // OUTSIDE the lexically-checked boundary. Refuse parent-traversal outright when a trust root is asserted;
  // credential paths never legitimately contain `..` (qodo security finding on #234). A name like `..config`
  // is a real component, not traversal, so only the exact `..` segment is rejected.
  if (boundary !== undefined && dir.split(sep).includes('..')) {
    throw new Error(`refusing to create credential directory ${dir}: a parent-traversal ('..') segment is not allowed under a trust root`);
  }

  // Fast path: the target already exists and is a safe, euid-owned directory → accept as-is (never
  // chmodded, exactly like an existing parent). Its natural ENOENT means "absent → create it" below.
  try {
    assertSafeExistingDir(dir, euid);
    // HED-634: an existing leaf is not enough — also reject an unsafe IMMEDIATE PARENT (symlink /
    // non-dir / group-or-other-writable), matching the create-path climb in createSecureDirTree. Otherwise a safe,
    // euid-owned leaf that already exists under a group/other-writable ancestor is accepted on a re-run,
    // while a first run (which takes the create path) would refuse it. Structural only (no euid): a
    // legitimately root-owned parent such as ~ or /Users is fine, and the parent is guaranteed to exist
    // here because the leaf does.
    assertSafeExistingDir(dirname(dir));
    // HED-643: with a trust root, extend that structural check up the EXISTING ancestor chain to (but not
    // including) `boundary`. Re-checks the immediate parent — idempotent, one extra lstat.
    if (boundary !== undefined) assertSafeAncestorsUpTo(dirname(dir), boundary);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Absent → build the target and any missing ancestors via the validated per-level walk (shared with
  // ensureSafeParent — HED-626). The fast path above already handled the existing-target case.
  createSecureDirTree(dir, mode, euid, boundary);
}

/**
 * Build an ABSENT directory and its missing ancestors by a per-level walk (never a single recursive
 * `mkdir`): climb to the deepest existing ancestor — rejecting a symlinked / non-dir /
 * group-or-other-writable ancestor STRUCTURALLY along the way — then create each missing component
 * top-down and, on that component's own `O_DIRECTORY | O_NOFOLLOW` fd, verify euid-ownership and force the
 * mode to exactly `mode` BEFORE descending into it. The walk is required because `mkdir`'s mode argument is
 * umask-masked: a single recursive create under a restrictive umask (one stripping owner-execute) would
 * leave the FIRST new ancestor un-enterable, so creating the rest of the path fails EACCES and strands a
 * partial tree (HED-620). Forcing each level past umask on its own fd as we go keeps every created ancestor
 * enterable — so a directory CREATED here is never a deep-ancestor residual; only a PRE-EXISTING ancestor
 * above the deepest existing one stays out of scope (the module invariant), and you cannot create UNDER a
 * foreign-owned ancestor anyway (`mkdir` fails EACCES unless it is group/other-writable, which the climb
 * rejects). If a level's finalization fails (a symlink swapped in at the name, or the ownership check),
 * that half-initialized level is removed so a later call recreates it rather than accepting a partial one.
 * Each component is created NON-recursively, so a concurrent same-uid create of the same component surfaces
 * EEXIST rather than being silently adopted unvalidated — callers that create the same tree concurrently
 * serialize or retry.
 *
 * The climb is STRUCTURAL only (no euid) even though the caller resolved a `euid` for the levels created: a
 * legitimately root-owned existing ancestor (`~`, `/Users`) must not be rejected against the caller's euid,
 * and euid-ownership of what THIS function makes is enforced by `finalizeCreatedDir` on each created
 * inode's fd. The caller owns `mode` and `euid` (both resolve/validate them before calling); this helper
 * does not re-gate `mode`. Shared by `ensureSecureDir` (its absent-target create path) and `ensureSafeParent`
 * (HED-626), so the writer's and lock's parent creation adopts the same umask-safe, ownership-verified walk.
 */
function createSecureDirTree(dir: string, mode: number, euid: number, boundary?: string): void {
  // Climb to the deepest existing ancestor, collecting the missing components to create top-down. The
  // climb requires only STRUCTURAL safety of existing ancestors (not a symlink / not a non-dir / not
  // group-or-other-writable), not euid-ownership: you cannot `mkdir` under a foreign-owned ancestor unless
  // it is group/other-writable, and that is exactly what assertSafeExistingDir rejects here — so a foreign
  // ancestor either trips the rejection or fails the create with EACCES, never silently holds credentials.
  const missing = [dir];
  let cur = dirname(dir);
  for (;;) {
    try {
      assertSafeExistingDir(cur);
      break; // deepest existing ancestor found — everything in `missing` sits below it
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (dirname(cur) === cur) break; // reached the filesystem root without an existing ancestor (defensive)
    missing.unshift(cur);
    cur = dirname(cur);
  }

  // HED-643: the climb above validated only the DEEPEST existing ancestor (`cur`). With a trust root,
  // validate the rest of the EXISTING chain from there up to (but excluding) `boundary` too, so a symlinked
  // or group/other-writable ancestor higher in the heddle-owned subtree is rejected before we create under
  // it. Guarded to the case where `cur` is within (or is) the trust root: if `boundary` does not yet exist
  // it is among the `missing` components created + mode-forced + euid-verified below by finalizeCreatedDir,
  // and `cur` then sits ABOVE `boundary` (the operator/OS domain) — nothing to validate, and we must not
  // climb into it.
  if (boundary !== undefined) {
    const rcur = resolve(cur); // canonical compare — `boundary` was resolved once at the entry point
    if (rcur === boundary || isStrictlyWithin(rcur, boundary)) assertSafeAncestorsUpTo(cur, boundary);
  }

  // Create each missing component top-down. Each is created then immediately finalized on its own fd
  // (euid-ownership verified, mode forced past umask); a level that fails finalization is rolled back so a
  // retry recreates it rather than a later call accepting a partially-initialized directory as existing.
  for (const component of missing) {
    mkdirSync(component, { mode });
    try {
      finalizeCreatedDir(component, mode, euid);
    } catch (err) {
      try {
        rmdirSync(component);
      } catch {
        // Best-effort rollback: a symlink swapped in at the name (ENOTDIR) or an already-removed dir —
        // preserve the original finalization failure, which is the one worth surfacing.
      }
      throw err;
    }
  }
}

/**
 * Validate that an EXISTING directory is safe to hold credentials, without creating anything: a euid-owned
 * real directory, not a symlink, not group/other-writable. The validate-only companion to `ensureSecureDir`
 * (e.g. to check a config directory a caller expects to already exist). An absent directory surfaces its
 * natural ENOENT unchanged, so a caller can distinguish "absent" from "present but unsafe".
 */
export function assertSecureDir(dir: string, opts: { euid?: number } = {}): void {
  assertSafeExistingDir(dir, effectiveUid(opts.euid));
}

/**
 * Claim the credential lock. A fresh claim and every reclaim write go through `claimLock`, which publishes
 * the lock atomically-with-content via `link()`: of any number of racing acquirers exactly one link wins,
 * and the lock name never exists empty. A LIVE or foreign-owned or symlinked lock is refused outright.
 * A STALE/unreadable lock is removed and re-claimed behind an atomic `mkdir(<lock>.reclaim)` gate that
 * serializes reclaimers; the reclaim re-inspects the lock UNDER the gate and, if it was released and a
 * fresh claimant took it, the reclaiming link fails EEXIST and we refuse rather than stomp it.
 *
 * Threat model: races between acquirers that all use THIS function are fully guarded — the gate serializes
 * reclaimers and a fresh acquirer's link cannot create over a present lock, so a stale lock stays put until
 * the gate holder replaces it. A same-uid process that manipulates the lock file OUTSIDE this library (an
 * out-of-band unlink between our inspect and our remove, say) is out of scope: it already holds the
 * credentials this lock coordinates, so it is not a boundary we can or need to defend (same residual as
 * deep-ancestor path components). Narrow crash limitation: a crash after making `.reclaim` but before
 * removing it blocks future reclaims until a manual `heddle rotate unlock` (HED-452 PR-2).
 *
 * Lock files are managed ONLY by acquire/releaseCredentialLock. Never point `secureWriteFile` at a lock
 * path: its atomic `rename` REPLACES the target name and would stomp a live holder's lock inode.
 */
export function acquireCredentialLock(
  lockPath: string,
  pid: number = process.pid,
  // onReclaimGate / onBeforeClaim are TEST-ONLY seams (like isAlive): they let a test model another
  // process acting inside the reclaim window. onReclaimGate fires while the gate is held, BEFORE the
  // authoritative re-inspection; onBeforeClaim fires after the stale lock is removed, immediately BEFORE
  // our atomic claim (the window a non-gated fresh claimant can win — the finding-#1 interleave).
  opts: { isAlive?: (pid: number) => boolean; euid?: number; onReclaimGate?: () => void; onBeforeClaim?: () => void } = {},
): CredentialLockResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`refusing to claim credential lock: invalid pid ${pid}`);
  const euid = effectiveUid(opts.euid);
  const isAlive = opts.isAlive ?? processAlive;
  ensureSafeParent(dirname(lockPath), 0o700);

  // Fast path: publish the lock atomically-with-content (see claimLock). A successful claim on a free name
  // wins outright; a pre-existing name (link EEXIST) means a lock is already there → inspect it below.
  if (claimLock(lockPath, pid)) return { ok: true };

  // Fast-path refusal WITHOUT taking the reclaim gate — confines the gate (and its crash-leak window)
  // to genuine stale reclaims. A symlink/non-file/foreign lock, a live holder, or a lock caught mid-
  // creation (null pid + fresh mtime) is refused here.
  const pre = inspectLock(lockPath, euid, isAlive);
  if (pre.refuse) return pre.result;

  // The reclaim gate is a NAME, not a permission boundary: mkdir's mode is umask-subject, but that is
  // irrelevant here — mutual exclusion is the atomic EEXIST on the name, and creating/removing it needs
  // only the (already validated) parent's permissions. umask can only REMOVE bits, so a created dir can
  // never gain the group/other-writable bits assertSafeExistingDir rejects (same for the lock parent).
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    mkdirSync(reclaimPath, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false };
    throw err;
  }
  try {
    opts.onReclaimGate?.();
    // Authoritative re-inspection under the gate: the pre-gate read is only an optimization, and a
    // staggered reclaimer may have released or replaced the lock since. Never stomp a live/foreign one.
    const held = inspectLock(lockPath, euid, isAlive);
    if (held.refuse) return held.result;
    if (held.present) unlinkSync(lockPath); // stale/unreadable regular euid-owned file → remove (no follow)
    opts.onBeforeClaim?.();
    // Same atomic claim as the fast path: if a non-gated fresh acquirer won the unlink→claim window, our
    // link fails EEXIST and we refuse rather than stomp its lock.
    return claimLock(lockPath, pid) ? { ok: true } : { ok: false };
  } finally {
    try {
      rmdirSync(reclaimPath);
    } catch {
      // A leaked .reclaim blocks future reclaims until `heddle rotate unlock` (PR-2); never fatal to a
      // takeover that already succeeded.
    }
  }
}

/**
 * Best-effort release for `finally`. Unlinks ONLY if the lock still holds `pid` (our claim): if it was
 * reclaimed and a different process now holds the name, removing it would strand that holder and admit a
 * third — so a lock that is not ours, or is no longer a regular file, is left untouched. `pid` is the
 * caller's OWN live pid; releasing on behalf of a dead process is unsupported (a TOCTOU against a
 * concurrent reclaim exists only for a dead pid, and the default is the live self).
 */
export function releaseCredentialLock(lockPath: string, pid: number = process.pid): void {
  try {
    if (!lstatSync(lockPath).isFile()) return; // symlink / non-file → not a lock we wrote
    if (readLockPid(lockPath) !== pid) return; // someone else holds it now → do not unlink
    unlinkSync(lockPath);
  } catch {
    // ENOENT (already gone) or any error: cleanup must not mask the credential operation's outcome.
  }
}

/**
 * NOTE — `withCredentialLock` (a wrapper that ran a callback while holding the lock) was intentionally
 * DEFERRED to HED-452 PR-2 and is NOT part of these inert primitives. Rationale: its only real consumer is
 * PR-2's async credential swap, and a generic sync/async wrapper had to inspect a thenable result to decide
 * whether to release synchronously or after the promise settled — that thenable-sniffing produced a HIGH
 * finding in three consecutive adversarial rounds (a mis-timed release before an async body ran, a double
 * release via a hand-rolled `then` that admitted a concurrent holder, and a lock leak via a throwing
 * `then`-getter). PR-2 will build the guard against its real `async` caller as
 * `acquire → try { await fn() } finally { release }`, where there is no synchronous return path and thus
 * nothing to sniff, and the API is async-only. Adopters that need the lock today (HED-586/590/591) call
 * `acquireCredentialLock` / `releaseCredentialLock` directly around their own work.
 */

/**
 * Classify an existing lock file. `refuse` (with its result) means never touch it — a symlink/non-file
 * (attack), a foreign owner, a live holder, or a lock caught mid-creation (null pid + fresh mtime).
 * `present:false` means absent/vanished (claimable). Anything else is a stale/unreadable regular
 * euid-owned file (reclaimable).
 */
function inspectLock(
  lockPath: string,
  euid: number,
  isAlive: (pid: number) => boolean,
): { refuse: boolean; result: CredentialLockResult; present: boolean } {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(lockPath);
  } catch {
    return { refuse: false, result: { ok: false }, present: false };
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== euid) return { refuse: true, result: { ok: false }, present: true };
  const heldBy = readLockPid(lockPath);
  if (heldBy !== null && isAlive(heldBy)) return { refuse: true, result: { ok: false, heldBy }, present: true };
  // A null pid is an empty/garbage lock. If it was just written it may be another acquirer's lock caught
  // between its create and its pid write — back off briefly rather than reclaim a lock in progress. (Our
  // own claimLock never produces an empty lock; this defends against one written OUTSIDE this library.)
  if (heldBy === null && Date.now() - stats.mtimeMs < CREATION_GRACE_MS) return { refuse: true, result: { ok: false }, present: true };
  return { refuse: false, result: { ok: false }, present: true };
}

/**
 * Publish a lock file containing `pid` atomically-with-content. The pid is written in full to a private
 * random-suffix temp, which is then `link()`ed into place at `lockPath`. Because the name at `lockPath`
 * springs into existence already pointing at the fully-written inode, there is NO window in which the lock
 * exists empty — closing the race where an acquirer paused between an `O_EXCL` create and a SEPARATE pid
 * write leaves an empty inode that a second acquirer, past the creation grace, reclaims (both would then
 * "hold" it). `link()` is atomic and never follows a symlink at `lockPath`: a pre-existing name — a regular
 * file OR a planted symlink — yields EEXIST, so we lose the race cleanly and never write through it. Its
 * atomicity is a trusted syscall property, like `O_EXCL`'s. Returns true iff we created the lock.
 */
function claimLock(lockPath: string, pid: number): boolean {
  const temporary = join(dirname(lockPath), `.${basename(lockPath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    // Write the pid to a private temp through an OPEN fd and fchmod THAT fd, exactly as secureWriteFile
    // does, so the 0o600 is guaranteed against a restrictive umask. A plain writeFileSync mode is
    // umask-masked: under a umask that strips owner-read the lock would be created non-owner-readable, and
    // then a second acquirer past the creation grace cannot read the pid, misclassifies the lock as
    // garbage, and reclaims it — admitting a second holder. Mode is an inode property, so fchmod on the
    // temp fd carries through link() to lockPath. link() then publishes the fully-written inode atomically:
    // the lock name never exists empty, and a pre-existing name (a regular file OR a planted symlink)
    // yields EEXIST — our lost-race signal — never a stomp or a write-through. link()'s atomicity and its
    // EEXIST-on-symlink behavior are trusted POSIX syscall properties, like O_EXCL's.
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, String(pid), 'utf8');
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false; // name already taken → we lost
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort: preserve the original failure.
      }
    }
    // Best-effort: drop the temp. After a successful link() the lock keeps its own link, so this only
    // removes the now-redundant temp name; a failed cleanup here leaves benign litter (a stray .tmp / an
    // nlink of 2), never a correctness issue. We must NOT roll back a lock we already hold on a cleanup
    // failure — that would strand our own critical section.
    try {
      unlinkSync(temporary);
    } catch {
      // The temp may never have been created, or cleanup failed; never mask the claim outcome.
    }
  }
}

/**
 * Create a missing parent (and any missing ancestors) at `mode` via the shared per-level walk
 * `createSecureDirTree` (HED-626 — never a umask-subject recursive `mkdir`), or accept an existing one only
 * if it is tamper-resistant. A concurrent same-uid creator is tolerated by RE-VALIDATING (not blindly
 * adopting) the directory it won — see the body. Pass `euid` to additionally require the EXISTING directory
 * to be owned by it (the writer does; the lock does not — so the existing-dir fast path stays euid-optional).
 */
function ensureSafeParent(parent: string, mode: number, euid?: number): void {
  // Validate-or-create, retrying on a concurrent create. HED-626: the absent branch builds the parent (and
  // any missing ancestors) with the SAME validated per-level walk ensureSecureDir uses, not a single
  // umask-subject `mkdir -p` — otherwise a restrictive umask that strips owner-execute strands a partial,
  // un-enterable tree (EACCES).
  //
  // The non-recursive walk throws EEXIST when another same-uid process creates a collected component between
  // our climb and our mkdir. The OLD recursive `mkdir` tolerated that race — but BLINDLY: a peer that
  // created `parent` group/other-writable in the window was accepted with NO re-validation and a secret was
  // written into it. Looping back to assertSafeExistingDir re-validates the peer's directory (structural +,
  // for the writer, euid), so this is race-tolerant AND tightening — it closes that gap rather than restoring it.
  //
  // The two validate calls are deliberately distinct: the fast path passes the RAW optional `euid` (so the
  // lock, which passes none, keeps its euid-OPTIONAL existing-parent check — module invariant), while only
  // the create branch resolves effectiveUid(euid) for the levels it makes (a dir it just created is
  // process-owned, so finalizeCreatedDir passes). Do NOT collapse them into one euid.
  //
  // Bounded: each EEXIST means a peer advanced the missing chain by >=1 existing level, so honest iterations
  // are bounded by the chain depth; the cap only stops a same-uid create-then-delete peer (already holds the
  // credentials — out of the module's threat model) from spinning, and exhaustion rethrows EEXIST (fail closed).
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      assertSafeExistingDir(parent, euid);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      createSecureDirTree(parent, mode, effectiveUid(euid));
      return;
    } catch (err) {
      // A peer created a component first → re-validate the now-existing tree on the next iteration. Any
      // other error (an unsafe peer dir trips assertSafeExistingDir next pass), or exhaustion, propagates.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= maxAttempts) throw err;
    }
  }
}

/**
 * Reject an immediate parent another user could tamper with: a symlink, a non-directory, or one that is
 * group/other-WRITABLE. A 0755 profile dir passes (`0o755 & 0o022 === 0`); 0775/0777/0757 do not. When
 * `euid` is given, the directory must also be owned by it. Throws the underlying ENOENT when the directory
 * is absent so callers can distinguish "create it".
 */
function assertSafeExistingDir(dir: string, euid?: number): void {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink()) throw new Error(`refusing: directory ${dir} is a symlink`);
  if (!stats.isDirectory()) throw new Error(`refusing: ${dir} is not a directory`);
  if ((stats.mode & 0o022) !== 0) throw new Error(`refusing: directory ${dir} is group- or other-writable`);
  if (euid !== undefined && stats.uid !== euid) throw new Error(`refusing: directory ${dir} is not owned by effective uid ${euid}`);
}

/**
 * True iff `child` is a STRICT descendant of `ancestor`. Used to validate a caller-supplied `boundary`
 * (trust root) before an ancestor-chain walk, so a boundary that is not actually above the target fails
 * loud at the entry point rather than letting the walk climb to the filesystem root. Both args are already
 * resolved (canonical, absolute). POSIX-only (this module relies on `process.geteuid`): `relative()` returns
 * empty when equal; a result that IS `..` or begins with `../` escapes upward; absolute means a different
 * root — any of those means `child` is at or outside `ancestor`. Testing the exact `..` / `../` forms (not a
 * bare `..` prefix) avoids wrongly rejecting a legitimate child directory named e.g. `..config`.
 */
function isStrictlyWithin(child: string, ancestor: string): boolean {
  const rel = relative(ancestor, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Validate every EXISTING directory on the chain from `from` (inclusive) climbing toward the filesystem
 * root, STOPPING at `boundary` (EXCLUSIVE) — the trust root the caller declares (e.g. its home directory).
 * Each level must be a real directory, not a symlink, and not group/other-writable (`assertSafeExistingDir`,
 * STRUCTURAL only — never euid, so a legitimately root-owned level on the path such as `/Users` is accepted,
 * exactly as the immediate-parent and create-climb checks are). This closes the ancestor-chain TOCTOU gap
 * (HED-643, same axis as HED-642): a fast path and the create-climb otherwise validate only the immediate / deepest-existing
 * parent, so a symlinked or group/other-writable ancestor HIGHER in the heddle-owned subtree could redirect
 * where a credential directory resolves. `boundary` itself and anything above it are the operator/OS trust
 * domain and are deliberately NOT validated; callers pass a `boundary` that is a strict ancestor of the
 * target (verified by `isStrictlyWithin` at the entry point), and the fs-root break is a defensive backstop.
 * Every ancestor of an existing or just-created directory exists, so `assertSafeExistingDir`'s ENOENT cannot
 * fire here.
 */
function assertSafeAncestorsUpTo(from: string, boundary: string): void {
  // `boundary` is pre-resolved by the caller; resolve `from` to the same canonical form so the stop compare
  // is exact even when the caller's boundary had a trailing slash or a `.`/`..` alias.
  let cur = resolve(from);
  while (cur !== boundary) {
    assertSafeExistingDir(cur);
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root reached without meeting boundary (defensive)
    cur = parent;
  }
}

/**
 * Finalize a directory THIS module just created (one component of the `ensureSecureDir` walk), acting on an
 * fd rather than the path: open it `O_DIRECTORY | O_NOFOLLOW` — never following a symlink swapped in at the
 * name, and guaranteeing the fd is a directory — then verify the created inode is owned by `euid` and
 * `fchmod` it to exactly `mode`. The ownership check runs BEFORE the chmod so the absent-create path
 * enforces the same euid-ownership invariant `assertSafeExistingDir` enforces for an existing directory
 * (mirroring how `secureWriteFile` fstat-checks its open fd). `mkdir`'s mode argument is umask-masked (a
 * 0o700 request lands as 0o600 under a umask that strips owner-execute → an un-enterable credential dir),
 * so this fd `fchmod` — which ignores umask and acts on the just-made inode — is what actually guarantees
 * the mode, exactly as the file writer fchmods its temp fd.
 */
function finalizeCreatedDir(dir: string, mode: number, euid: number): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).uid !== euid) throw new Error(`refusing: created directory ${dir} is not owned by effective uid ${euid}`);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function effectiveUid(injected: number | undefined): number {
  if (injected !== undefined) return injected;
  if (typeof process.geteuid !== 'function') throw new Error('secure filesystem operations require process.geteuid()');
  return process.geteuid();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but we may not signal it → alive. ESRCH (or anything else) → dead.
    // Treating EPERM as dead would falsely reclaim a live holder's lock and admit a second holder.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    // No trim: our writer emits exactly `String(pid)` (no surrounding whitespace or newline), so the RAW
    // body must be a plain decimal run. A bare `Number()` would accept '1e3' (1000) or '0x10' (16); a
    // `.trim()` would let '  1  ' pass as pid 1 (init — always "alive") and wedge the lock forever.
    // Requiring ^\d+$ on the raw bytes makes any malformed body null (garbage → reclaimable when stale),
    // the safe classification. (JS `$` without the `m` flag matches end-of-input only, so a trailing
    // newline is rejected too, not tolerated.)
    const raw = readFileSync(lockPath, 'utf8');
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
