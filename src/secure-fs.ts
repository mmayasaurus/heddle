import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

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
 * They do NOT walk ancestors: Node exposes no per-component `O_NOFOLLOW`/`openat`/`RESOLVE_NO_SYMLINKS`
 * and this project takes zero native deps, so a symlink or a group/other-writable directory HIGHER in the
 * path (or, for the reader/lock, a foreign-owned immediate parent) is not detected here. That is acceptable
 * only because every path these guard is heddle-owned under `~/.heddle` or a user-owned profile dir — a
 * same-uid trust domain a cross-uid attacker cannot write to, and a same-uid process already holds the
 * credentials outright. Callers MUST pass paths whose ancestors are user-owned and not group/other-writable.
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
 * Ensure a directory exists and is safe to hold credentials: create it (and any missing ancestors) at
 * `mode` when absent, or accept an existing one only if it is a euid-owned real directory that is not a
 * symlink and not group/other-writable. This is the directory analogue of `secureWriteFile` for the
 * HED-586/590/591 F-cluster — e.g. the native account config directory the CLI later writes
 * `.credentials.json` into — so all three adopt ONE validated create-or-validate path instead of each
 * hand-rolling `lstat` checks.
 *
 * The requested `mode` is validated first: a credential directory must not be group/other-WRITABLE, so a
 * `mode` carrying 0o022 is rejected (matching `secureWriteFile`'s `dirMode` guard) rather than silently
 * honored. When the directory is CREATED, its mode is forced to exactly `mode` through an
 * `O_DIRECTORY | O_NOFOLLOW` fd + `fchmod` — the same fd-based technique the file writer uses — because
 * `mkdir`'s mode argument is umask-masked: under a restrictive umask a 0o700 request would otherwise land
 * as e.g. 0o600 (no owner-execute → an unusable credential dir). `fchmod` ignores umask and acts on the
 * just-created inode, and `O_NOFOLLOW` refuses a symlink swapped in at the final component. An EXISTING
 * directory is validated but never chmodded (a legitimate 0755 profile dir is accepted, exactly as the
 * writer accepts a 0755 parent). Ancestors created by the recursive `mkdir` are the documented
 * deep-ancestor residual (module invariant): only the final directory is force-moded and re-opened
 * `O_NOFOLLOW`.
 */
export function ensureSecureDir(dir: string, opts: { mode?: number; euid?: number } = {}): void {
  const mode = opts.mode ?? 0o700;
  if ((mode & 0o022) !== 0) throw new Error(`refusing to create credential directory ${dir}: mode 0${mode.toString(8)} would be group/other-writable`);
  const euid = effectiveUid(opts.euid);
  try {
    assertSafeExistingDir(dir, euid);
    return; // already a safe, euid-owned directory → accept as-is (never chmodded, like an existing parent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Absent → create (recursively; missing ancestors are the deep-ancestor residual) then force the final
  // directory's mode past umask via an fd, exactly as the file writer fchmods its temp fd.
  mkdirSync(dir, { recursive: true, mode });
  forceDirMode(dir, mode);
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
 * Create a missing parent at `mode`, or accept an existing one only if it is tamper-resistant. Pass `euid`
 * to additionally require the existing directory to be owned by it (the writer does; the lock does not).
 */
function ensureSafeParent(parent: string, mode: number, euid?: number): void {
  try {
    assertSafeExistingDir(parent, euid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(parent, { recursive: true, mode });
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
 * Force an existing directory's mode to exactly `mode` against a restrictive umask, acting on an fd rather
 * than the path: open it `O_DIRECTORY | O_NOFOLLOW` (never following a symlink at the final component) and
 * `fchmod` that fd, mirroring how the file writer fchmods its temp fd. Called only immediately after we
 * created the directory ourselves, so the fd is our just-made inode; `O_NOFOLLOW` additionally refuses a
 * symlink a same-uid racer could have swapped in between the create and this call.
 */
function forceDirMode(dir: string, mode: number): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
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
