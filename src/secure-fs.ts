import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * group/other-WRITABLE. They do NOT walk ancestors, nor do they assert OWNERSHIP of the parent: Node
 * exposes no per-component `O_NOFOLLOW`/`openat`/`RESOLVE_NO_SYMLINKS` and this project takes zero native
 * deps, so a symlink or a group/other-writable directory HIGHER in the path, or a foreign-owned immediate
 * parent, is not detected here. That is acceptable only because every path these guard is heddle-owned
 * under `~/.heddle` or a user-owned profile dir — a same-uid trust domain a cross-uid attacker cannot
 * write to. Callers MUST pass paths whose ancestors are user-owned and not group/other-writable.
 */

let temporarySequence = 0;

/** Result of attempting to claim a credential-operation lock. */
export interface CredentialLockResult {
  ok: boolean;
  /** The process already holding the lock, when it could be determined. */
  heldBy?: number;
}

/**
 * Atomically write a secret without inheriting permissions from an older, possibly permissive file.
 *
 * Secret-bearing profile directories can legitimately be 0755, so an existing parent is checked for
 * directory-ness, for not being a symlink, and for the absence of group/other WRITE (which would let
 * another account swap the file) — but is intentionally neither chmodded nor required to be private.
 */
export function secureWriteFile(path: string, content: string, opts: { mode?: number; dirMode?: number; euid?: number } = {}): void {
  const euid = effectiveUid(opts.euid);
  ensureSafeParent(dirname(path), opts.dirMode ?? 0o700);

  try {
    const target = lstatSync(path);
    if (target.isSymbolicLink()) throw new Error(`refusing to write secret file ${path}: target is a symlink`);
    if (!target.isFile()) throw new Error(`refusing to write secret file ${path}: target is not a regular file`);
    if (target.uid !== euid) throw new Error(`refusing to write secret file ${path}: target is not owned by effective uid ${euid}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const mode = opts.mode ?? 0o600;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${temporarySequence++}.tmp`);
  try {
    // The temporary file is in the target directory, making rename atomic on one filesystem. `wx`
    // (O_EXCL) never follows a symlink and never clobbers a pre-existing temp. Explicit chmod counters a
    // restrictive umask and guarantees the requested final mode. rename() replaces the target NAME
    // without following a symlink at that name, so a symlink swapped in after the lstat above is
    // overwritten, not written through.
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
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
 * so callers receive a descriptive error instead.
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
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`refusing to read secret file ${path}: target is a symlink`);
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
 * Narrow limitation: a crash after making `.reclaim` but before removing it leaves that directory and
 * blocks future reclaims until a manual `heddle rotate unlock` (HED-452 PR-2). Deliberate — the normal
 * races are fully guarded and the gate is entered only for a genuine stale reclaim.
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
  const euid = effectiveUid(opts.euid);
  const isAlive = opts.isAlive ?? processAlive;
  ensureSafeParent(dirname(lockPath), 0o700);

  try {
    writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Fast-path refusal WITHOUT taking the reclaim gate — confines the gate (and its crash-leak window)
  // to genuine stale reclaims. A symlink/non-file/foreign lock or a live holder is refused here.
  const pre = inspectLock(lockPath, euid, isAlive);
  if (pre.refuse) return pre.result;

  const reclaimPath = `${lockPath}.reclaim`;
  try {
    mkdirSync(reclaimPath);
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
      writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'wx' });
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

/** Best-effort release for `finally`: a leftover lock is reclaimed safely by a later process. */
export function releaseCredentialLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Deliberately swallowed: cleanup must not mask a credential operation's outcome.
  }
}

/** Run a synchronous credential operation while holding its single-process lock. */
export function withCredentialLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { pid?: number; isAlive?: (pid: number) => boolean; euid?: number } = {},
): T {
  const result = acquireCredentialLock(lockPath, opts.pid, { isAlive: opts.isAlive, euid: opts.euid });
  if (!result.ok) {
    throw new Error(result.heldBy === undefined
      ? `could not acquire credential lock at ${lockPath}`
      : `credential lock at ${lockPath} is held by pid ${result.heldBy}`);
  }
  try {
    return fn();
  } finally {
    releaseCredentialLock(lockPath);
  }
}

/**
 * Classify an existing lock file. `refuse` (with its result) means never touch it — a symlink/non-file
 * (attack), a foreign owner, or a live holder. `present:false` means absent/vanished (claimable).
 * Anything else is a stale/unreadable regular euid-owned file (reclaimable).
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
  return { refuse: false, result: { ok: false }, present: true };
}

/** Create a missing parent at `mode`, or accept an existing one only if it is tamper-resistant. */
function ensureSafeParent(parent: string, mode: number): void {
  try {
    assertSafeExistingDir(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(parent, { recursive: true, mode });
  }
}

/**
 * Reject an immediate parent another user could tamper with: a symlink, a non-directory, or one that is
 * group/other-WRITABLE. A 0755 profile dir passes (`0o755 & 0o022 === 0`); 0775/0777/0757 do not.
 * Ownership is NOT asserted here (see the module invariant — the target's own FD/file ownership check is
 * the authoritative cross-uid guard). Throws the underlying ENOENT when the directory is absent so
 * callers can distinguish "create it".
 */
function assertSafeExistingDir(dir: string): void {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink()) throw new Error(`refusing: directory ${dir} is a symlink`);
  if (!stats.isDirectory()) throw new Error(`refusing: ${dir} is not a directory`);
  if ((stats.mode & 0o022) !== 0) throw new Error(`refusing: directory ${dir} is group- or other-writable`);
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
