import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * (all post-check ops are on the open fd) and the lock (its claim is a single O_EXCL create) have no such
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

/** Options shared by the lock primitives. */
export interface CredentialLockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  euid?: number;
}

/** Result of attempting to claim a credential-operation lock. */
export interface CredentialLockResult {
  ok: boolean;
  /** The process already holding the lock, when it could be determined. */
  heldBy?: number;
}

/**
 * Atomically write a secret without inheriting permissions from an older, possibly permissive file.
 *
 * The target is validated FIRST (a symlink / non-file / foreign-owned name is refused), THEN the parent:
 * checking the target before the parent keeps BOTH ownership guards seam-testable (a foreign pre-existing
 * target trips the target check; a foreign parent with an absent target trips the parent check). Secret-
 * bearing profile directories can legitimately be 0755, so an existing parent is accepted at that mode —
 * but it must be a euid-owned directory (not a symlink, not group/other-writable) and is never chmodded.
 */
export function secureWriteFile(path: string, content: string, opts: { mode?: number; dirMode?: number; euid?: number } = {}): void {
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
  ensureSafeParent(dirname(path), opts.dirMode ?? 0o700, euid);

  const mode = opts.mode ?? 0o600;
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
 * Claim the credential lock. A fresh claim and every reclaim write go through `O_EXCL` (`flag: 'wx'`),
 * which is atomic and never follows a symlink, so it is always the last word: of any number of racing
 * acquirers exactly one `wx` create wins. A LIVE or foreign-owned or symlinked lock is refused outright.
 * A STALE/unreadable lock is removed and re-claimed behind an atomic `mkdir(<lock>.reclaim)` gate that
 * serializes reclaimers; the reclaim re-inspects the lock UNDER the gate and, if it was released and a
 * fresh claimant took it, the reclaiming `wx` fails EEXIST and we refuse rather than stomp it.
 *
 * Threat model: races between acquirers that all use THIS function are fully guarded — the gate serializes
 * reclaimers and a fresh acquirer's `wx` cannot create over a present lock, so a stale lock stays put until
 * the gate holder replaces it. A same-uid process that manipulates the lock file OUTSIDE this library (an
 * out-of-band unlink between our inspect and our remove, say) is out of scope: it already holds the
 * credentials this lock coordinates, so it is not a boundary we can or need to defend (same residual as
 * deep-ancestor path components). Narrow crash limitation: a crash after making `.reclaim` but before
 * removing it blocks future reclaims until a manual `heddle rotate unlock` (HED-452 PR-2).
 */
export function acquireCredentialLock(
  lockPath: string,
  pid: number = process.pid,
  // onReclaimGate / onBeforeClaim are TEST-ONLY seams (like isAlive): they let a test model another
  // process acting inside the reclaim window. onReclaimGate fires while the gate is held, BEFORE the
  // authoritative re-inspection; onBeforeClaim fires after the stale lock is removed, immediately BEFORE
  // our O_EXCL claim (the window a non-gated fresh claimant can win — the finding-#1 interleave).
  opts: { isAlive?: (pid: number) => boolean; euid?: number; onReclaimGate?: () => void; onBeforeClaim?: () => void } = {},
): CredentialLockResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`refusing to claim credential lock: invalid pid ${pid}`);
  const euid = effectiveUid(opts.euid);
  const isAlive = opts.isAlive ?? processAlive;
  ensureSafeParent(dirname(lockPath), 0o700);

  try {
    writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Fast-path refusal WITHOUT taking the reclaim gate — confines the gate (and its crash-leak window)
  // to genuine stale reclaims. A symlink/non-file/foreign lock, a live holder, or a lock caught mid-
  // creation (null pid + fresh mtime) is refused here.
  const pre = inspectLock(lockPath, euid, isAlive);
  if (pre.refuse) return pre.result;

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
    try {
      writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false }; // a fresh claimant won the window
      throw err;
    }
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
 * Run a credential operation while holding its single-process lock, releasing it afterward. Works for both
 * a synchronous `fn` and an `async` one: when `fn` returns a promise the lock is held until that promise
 * SETTLES (a plain `try/finally` cannot do this — `finally` fires the instant `fn()` returns the pending
 * promise, releasing the lock before the async work runs).
 */
export function withCredentialLock<T>(lockPath: string, fn: () => Promise<T>, opts?: CredentialLockOptions): Promise<T>;
export function withCredentialLock<T>(lockPath: string, fn: () => T, opts?: CredentialLockOptions): T;
export function withCredentialLock<T>(lockPath: string, fn: () => T | Promise<T>, opts: CredentialLockOptions = {}): T | Promise<T> {
  const pid = opts.pid ?? process.pid;
  const result = acquireCredentialLock(lockPath, pid, { isAlive: opts.isAlive, euid: opts.euid });
  if (!result.ok) {
    throw new Error(result.heldBy === undefined
      ? `could not acquire credential lock at ${lockPath}`
      : `credential lock at ${lockPath} is held by pid ${result.heldBy}`);
  }
  let out: T | Promise<T>;
  try {
    out = fn();
  } catch (err) {
    releaseCredentialLock(lockPath, pid);
    throw err;
  }
  if (out != null && typeof (out as Promise<T>).then === 'function') {
    return (out as Promise<T>).then(
      (value) => { releaseCredentialLock(lockPath, pid); return value; },
      (err) => { releaseCredentialLock(lockPath, pid); throw err; },
    );
  }
  releaseCredentialLock(lockPath, pid);
  return out;
}

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
  // between its O_EXCL create and its pid write — back off briefly rather than reclaim a lock in progress.
  if (heldBy === null && Date.now() - stats.mtimeMs < CREATION_GRACE_MS) return { refuse: true, result: { ok: false }, present: true };
  return { refuse: false, result: { ok: false }, present: true };
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
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
