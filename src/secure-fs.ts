import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

let temporarySequence = 0;

/** Result of attempting to claim a credential-operation lock. */
export interface CredentialLockResult {
  ok: boolean;
  /** The live process already holding the lock, when it could be determined. */
  heldBy?: number;
}

/**
 * Atomically write a secret without inheriting permissions from an older, possibly permissive file.
 *
 * Secret-bearing profile directories can legitimately be 0755, so an existing parent is checked for
 * ownership and directory-ness but is intentionally neither chmodded nor required to be private.
 */
export function secureWriteFile(path: string, content: string, opts: { mode?: number; dirMode?: number; euid?: number } = {}): void {
  const euid = effectiveUid(opts.euid);
  const parent = dirname(path);
  ensureSafeParent(parent, euid, opts.dirMode ?? 0o700);

  try {
    const target = lstatSync(path);
    if (target.isSymbolicLink()) throw new Error(`refusing to write secret file ${path}: target is a symlink`);
    if (!target.isFile()) throw new Error(`refusing to write secret file ${path}: target is not a regular file`);
    if (target.uid !== euid) throw new Error(`refusing to write secret file ${path}: target is not owned by effective uid ${euid}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const mode = opts.mode ?? 0o600;
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${temporarySequence++}.tmp`);
  try {
    // The temporary file is in the target directory, making rename atomic on one filesystem. Explicit
    // chmod counters a restrictive umask and guarantees the requested final mode after the rename.
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
 */
export function secureReadFile(path: string, opts: { euid?: number } = {}): string {
  const euid = effectiveUid(opts.euid);
  // Open with O_NOFOLLOW so a symlink at the final path component fails the open outright (ELOOP),
  // then validate and read against the OPEN fd (fstat + read-from-fd). Nothing re-resolves the path
  // after the checks, which closes the check-then-read TOCTOU that a path-based lstat()+readFileSync()
  // leaves open (an attacker swapping in a symlink between the two).
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
 * Claim the credential lock using O_EXCL. A stale holder is reclaimed only after obtaining a separate
 * atomic mkdir gate, so two cold starters cannot both take over the same stale lock.
 *
 * Narrow limitation: a crash after making `.reclaim` but before removing it leaves that directory and
 * blocks future reclaims until manual unlock. This is deliberate: the normal two-starter race is fully
 * guarded, while the manual `heddle rotate unlock` escape hatch is supplied by HED-452 PR-2.
 */
export function acquireCredentialLock(
  lockPath: string,
  pid: number = process.pid,
  // onReclaimGate is a TEST-ONLY seam (like isAlive): it fires after the reclaim gate is won and
  // before the post-gate re-check, so a test can simulate another process reclaiming in that window.
  opts: { isAlive?: (pid: number) => boolean; euid?: number; onReclaimGate?: () => void } = {},
): CredentialLockResult {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  let existing;
  try {
    existing = lstatSync(lockPath);
  } catch {
    // The file disappearing between O_EXCL and inspection is a race; never guess that it is safe.
    return { ok: false };
  }
  if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== effectiveUid(opts.euid)) return { ok: false };

  const heldBy = readLockPid(lockPath);
  const isAlive = opts.isAlive ?? processAlive;
  if (heldBy !== null && isAlive(heldBy)) return { ok: false, heldBy };

  const reclaimPath = `${lockPath}.reclaim`;
  try {
    mkdirSync(reclaimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false };
    throw err;
  }
  try {
    // Re-check UNDER the gate. The mkdir gate alone only serializes SIMULTANEOUS reclaimers; a
    // STAGGERED one that fully reclaimed (mkdir→write→rmdir) between our stale-read above and our
    // winning this gate would leave a LIVE holder we must not stomp. Re-read the holder now: if it is
    // alive, abort. Deleting-then-reclaiming instead would be worse (it would erase that live claim).
    opts.onReclaimGate?.();
    const current = readLockPid(lockPath);
    if (current !== null && isAlive(current)) return { ok: false, heldBy: current };
    writeFileSync(lockPath, String(pid), 'utf8');
  } finally {
    rmdirSync(reclaimPath);
  }
  return { ok: true };
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

function ensureSafeParent(parent: string, euid: number, mode: number): void {
  try {
    const directory = lstatSync(parent);
    if (directory.isSymbolicLink()) throw new Error(`refusing to write secret file in ${parent}: parent is a symlink`);
    if (!directory.isDirectory()) throw new Error(`refusing to write secret file in ${parent}: parent is not a directory`);
    if (directory.uid !== euid) throw new Error(`refusing to write secret file in ${parent}: parent is not owned by effective uid ${euid}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(parent, { recursive: true, mode });
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
  } catch {
    return false;
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
