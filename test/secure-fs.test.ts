import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireCredentialLock,
  assertSecureDir,
  ensureSecureDir,
  releaseCredentialLock,
  secureReadFile,
  secureWriteFile,
} from '../src/secure-fs.js';
import { useTempResources } from './helpers.js';

describe('secure filesystem primitives', () => {
  const { tempDir } = useTempResources('heddle-secure-fs-test-');
  const euid = process.geteuid?.() ?? 0;
  const foreignEuid = euid + 1;

  it('secureWriteFile creates a missing parent at 0700 and its file at 0600', () => {
    const path = join(tempDir(), 'private', 'nested', 'credential');

    secureWriteFile(path, 'FAKE_SECRET_SENTINEL');

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('FAKE_SECRET_SENTINEL');
  });

  it('secureWriteFile accepts an existing 0755 parent without changing its mode', () => {
    const parent = join(tempDir(), 'claude-profile');
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    const path = join(parent, 'credential');

    secureWriteFile(path, 'FAKE_SECRET_SENTINEL');

    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(readFileSync(path, 'utf8')).toBe('FAKE_SECRET_SENTINEL');
  });

  it('secureWriteFile rewrites a pre-existing file’s content and does not copy its permissive mode', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_OLD_SECRET');
    chmodSync(path, 0o644);

    secureWriteFile(path, 'FAKE_SECRET_SENTINEL');

    // Content AND mode must change: an in-place chmod (leaving the old bytes) must not pass this.
    expect(readFileSync(path, 'utf8')).toBe('FAKE_SECRET_SENTINEL');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('secureWriteFile rejects a symlink target without writing its destination', () => {
    const root = tempDir();
    const destination = join(root, 'destination');
    const path = join(root, 'credential');
    writeFileSync(destination, 'FAKE_UNCHANGED_SECRET');
    symlinkSync(destination, path);

    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL')).toThrow(/symlink/i);
    expect(readFileSync(destination, 'utf8')).toBe('FAKE_UNCHANGED_SECRET');
  });

  it('secureWriteFile rejects a foreign-owned target through the euid seam', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_OLD_SECRET');

    // A pre-existing target trips the TARGET ownership check (which runs before the parent check).
    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL', { euid: foreignEuid })).toThrow(/owner|owned/i);
  });

  it('secureWriteFile rejects a foreign-owned parent when the target is absent', () => {
    // With no pre-existing target, the foreign-owned PARENT must still be caught — the writer requires a
    // euid-owned parent because it renames by pathname after its checks. This keeps the parent guard
    // seam-testable independently of the target guard above.
    const path = join(tempDir(), 'credential');

    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL', { euid: foreignEuid })).toThrow(/owner|owned/i);
  });

  it('secureWriteFile rejects a symlinked parent directory', () => {
    const root = tempDir();
    const realParent = join(root, 'realdir');
    const linkParent = join(root, 'linkdir');
    mkdirSync(realParent);
    symlinkSync(realParent, linkParent);

    expect(() => secureWriteFile(join(linkParent, 'credential'), 'FAKE_SECRET_SENTINEL')).toThrow(/symlink/i);
  });

  it('secureWriteFile rejects a group/other-writable parent directory', () => {
    const parent = join(tempDir(), 'loose');
    mkdirSync(parent);
    chmodSync(parent, 0o777);

    expect(() => secureWriteFile(join(parent, 'credential'), 'FAKE_SECRET_SENTINEL')).toThrow(/writable/i);
  });

  it('secureWriteFile does NOT detect a group/other-writable GRANDparent (documented deep-ancestor residual)', () => {
    // The primitive validates the immediate parent only (module invariant). A world-writable ancestor
    // higher up is NOT caught — callers must pass paths whose ancestors are user-owned/not group-writable.
    // This test pins that limitation so a future reviewer sees it is intentional, not an oversight.
    const grand = join(tempDir(), 'grand');
    mkdirSync(grand);
    chmodSync(grand, 0o777);
    const parent = join(grand, 'parent');
    mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, 'credential');

    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL')).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('FAKE_SECRET_SENTINEL');
  });

  it('secureWriteFile rejects a caller mode that would leak the secret to group/other', () => {
    const path = join(tempDir(), 'credential');

    // A secret must never be group/other-readable. {mode:0o644} is rejected at the door — before any file
    // is created — rather than silently written with the weakened permissions the caller asked us to set.
    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL', { mode: 0o644 })).toThrow(/mode|group|other/i);
    expect(existsSync(path)).toBe(false); // nothing written
  });

  it('secureWriteFile rejects a caller dirMode that would create a group/other-writable parent', () => {
    const path = join(tempDir(), 'newparent', 'credential');

    // {dirMode:0o777} under a permissive umask would create a world-writable parent that is never
    // post-validated. Rejected at the door, so the parent is not created at all.
    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL', { dirMode: 0o777 })).toThrow(/dirMode|writable/i);
    expect(existsSync(dirname(path))).toBe(false); // parent not created with the unsafe mode
  });

  it('secureReadFile returns a 0600 owner-owned file', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_SECRET_SENTINEL');
    chmodSync(path, 0o600);

    expect(secureReadFile(path)).toBe('FAKE_SECRET_SENTINEL');
  });

  it('secureReadFile rejects a group- or other-readable file', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_SECRET_SENTINEL');
    chmodSync(path, 0o644);

    expect(() => secureReadFile(path)).toThrow(/group|other|permission/i);
  });

  it('secureReadFile rejects a symlink', () => {
    const root = tempDir();
    const destination = join(root, 'destination');
    const path = join(root, 'credential');
    writeFileSync(destination, 'FAKE_SECRET_SENTINEL');
    chmodSync(destination, 0o600);
    symlinkSync(destination, path);

    expect(() => secureReadFile(path)).toThrow(/symlink/i);
  });

  it('secureReadFile rejects a foreign-owned file through the euid seam', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_SECRET_SENTINEL');
    chmodSync(path, 0o600);

    expect(() => secureReadFile(path, { euid: foreignEuid })).toThrow(/owner|owned/i);
  });

  it('secureReadFile lets an absent secret surface a natural ENOENT, not a security error', () => {
    const path = join(tempDir(), 'credential'); // parent (tempDir) exists; the secret does not

    let caught: NodeJS.ErrnoException | undefined;
    try { secureReadFile(path); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('ENOENT'); // bubbles unwrapped so a caller can probe for a not-yet-created secret
    expect(caught?.message ?? '').not.toMatch(/could not securely open/i);
  });

  it('secureReadFile rejects a symlinked parent directory', () => {
    const root = tempDir();
    const realParent = join(root, 'realdir');
    const linkParent = join(root, 'linkdir');
    mkdirSync(realParent);
    const secret = join(realParent, 'credential');
    writeFileSync(secret, 'FAKE_SECRET_SENTINEL');
    chmodSync(secret, 0o600);
    symlinkSync(realParent, linkParent);

    expect(() => secureReadFile(join(linkParent, 'credential'))).toThrow(/symlink/i);
  });

  it('secureReadFile rejects a group/other-writable parent directory', () => {
    const parent = join(tempDir(), 'loose');
    mkdirSync(parent);
    const secret = join(parent, 'credential');
    writeFileSync(secret, 'FAKE_SECRET_SENTINEL');
    chmodSync(secret, 0o600);
    chmodSync(parent, 0o777);

    expect(() => secureReadFile(secret)).toThrow(/writable/i);
  });

  it('acquireCredentialLock claims a free path', () => {
    const path = join(tempDir(), 'locks', 'credential.lock');

    expect(acquireCredentialLock(path, 12345)).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('12345');
    releaseCredentialLock(path, 12345);
  });

  it('acquireCredentialLock publishes the pid atomically (temp+link), leaving no empty window or temp residue', () => {
    const dir = join(tempDir(), 'locks');
    const path = join(dir, 'credential.lock');

    expect(acquireCredentialLock(path, 4242)).toEqual({ ok: true });
    // The lock carries the pid from the instant the name exists — it is link()ed in fully written, never
    // created empty and filled later (the empty-inode window). nlink===1 and no leftover .tmp prove the
    // private temp was linked into place and then dropped, not left as a second link or as litter.
    expect(readFileSync(path, 'utf8')).toBe('4242');
    expect(statSync(path).nlink).toBe(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    releaseCredentialLock(path, 4242);
  });

  it('acquireCredentialLock forces the lock to mode 0o600 despite a restrictive umask (keeps the holder detectable)', () => {
    const path = join(tempDir(), 'credential.lock'); // resolve tempDir BEFORE changing the umask
    const prevUmask = process.umask(0o400); // masks owner-READ from newly created files
    try {
      expect(acquireCredentialLock(path, 111)).toEqual({ ok: true });
      // claimLock fchmod()s the temp fd to 0o600, which carries through link() to the lock. Without it a
      // plain writeFileSync(mode) would be umask-masked to 0o200 (write-only): a second acquirer past the
      // creation grace could not read the pid, would misclassify the lock as garbage, and would reclaim it
      // → dual-acquire. The lock MUST end up exactly 0o600 and owner-readable.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('111');
    } finally {
      process.umask(prevUmask);
    }
  });

  it('acquireCredentialLock rejects an invalid pid rather than writing a self-reclaimable holder', () => {
    // NaN / 0 / fractional would be written then read back as unreadable/dead → instantly reclaimable by
    // a second live caller, so both "hold" it. Reject at the door instead.
    const path = join(tempDir(), 'credential.lock');

    expect(() => acquireCredentialLock(path, Number.NaN)).toThrow(/invalid pid/i);
    expect(() => acquireCredentialLock(path, 0)).toThrow(/invalid pid/i);
    expect(() => acquireCredentialLock(path, 1.5)).toThrow(/invalid pid/i);
    expect(existsSync(path)).toBe(false);
  });

  it('acquireCredentialLock refuses a live holder and names it, leaving its lock intact', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    // claim-fails-when-exists: our link into the taken name fails EEXIST → we inspect and refuse a live
    // holder WITHOUT truncating or replacing its lock (a path-write claim would have stomped it).
    expect(acquireCredentialLock(path, 222, { isAlive: () => true })).toEqual({ ok: false, heldBy: 111 });
    expect(readFileSync(path, 'utf8')).toBe('111');
  });

  it('acquireCredentialLock lets exactly one of two acquirers win a free path (concurrent double-claim)', () => {
    const path = join(tempDir(), 'credential.lock');

    // First cold-starter wins the free name via the atomic link claim.
    expect(acquireCredentialLock(path, 111, { isAlive: (pid) => pid === 111 })).toEqual({ ok: true });
    // A second acquirer arriving while 111 is alive must lose — the name is already taken (link EEXIST)
    // and 111 is live → refused and named. Two acquirers, never two {ok:true}.
    expect(acquireCredentialLock(path, 222, { isAlive: (pid) => pid === 111 })).toEqual({ ok: false, heldBy: 111 });
    expect(readFileSync(path, 'utf8')).toBe('111');
  });

  it('acquireCredentialLock refuses (no write-through) when a symlink sits at the fresh lock path', () => {
    const root = tempDir();
    const path = join(root, 'credential.lock');
    const secret = join(root, 'secret');
    writeFileSync(secret, 'FAKE_UNTOUCHED');
    symlinkSync(secret, path); // a symlink planted where the lock name would go

    // link() does not follow a symlink at the destination → EEXIST → we refuse. A plain path write would
    // instead follow the link and clobber `secret`. inspectLock then classifies the symlink as refuse.
    expect(acquireCredentialLock(path, 222)).toEqual({ ok: false });
    expect(lstatSync(path).isSymbolicLink()).toBe(true); // symlink neither chased nor removed
    expect(readFileSync(secret, 'utf8')).toBe('FAKE_UNTOUCHED'); // never written through the symlink
  });

  it('acquireCredentialLock treats a non-decimal lock body ("1e3") as garbage, not pid 1000', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '1e3'); // Number('1e3') === 1000
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // beyond the creation grace, so a genuine garbage lock is reclaimable

    // If readLockPid used a bare Number(), '1e3' would masquerade as live holder 1000 and be refused
    // (isAlive claims 1000 IS alive to prove the point). The /^\d+$/ guard makes it null → a garbage lock
    // older than the grace → reclaimable → we win.
    expect(acquireCredentialLock(path, 222, { isAlive: (pid) => pid === 1000 })).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('222');
  });

  it('acquireCredentialLock treats a whitespace-padded body (" 1 ") as garbage, not pid 1 (no trim)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, ' 1 '); // a trim()+Number() would read this as pid 1 (init, always "alive")
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // beyond the creation grace

    // readLockPid requires the RAW body to be ^\d+$ (no trim), so ' 1 ' is null → a garbage lock older
    // than the grace is reclaimable → we win, instead of the lock being wedged forever as a fake live pid 1.
    expect(acquireCredentialLock(path, 222, { isAlive: (pid) => pid === 1 })).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('222');
  });

  it('acquireCredentialLock treats an unsignalable (EPERM) holder as alive — real pid 1', () => {
    // pid 1 (launchd/init) exists but a non-root caller cannot signal it → kill(pid,0) throws EPERM.
    // A live holder that we merely cannot signal must NOT be reclaimed (finding #8). Uses the REAL
    // processAlive, so it exercises actual OS behavior rather than the isAlive seam.
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '1');

    expect(acquireCredentialLock(path, 222)).toEqual({ ok: false, heldBy: 1 });
    expect(readFileSync(path, 'utf8')).toBe('1');
  });

  it('acquireCredentialLock reclaims a stale holder and writes my pid', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    expect(acquireCredentialLock(path, 222, { isAlive: () => false })).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('222');
  });

  it('acquireCredentialLock backs off from a null-pid lock caught in its creation window (grace)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, ''); // empty → readLockPid null; mtime is fresh (another acquirer may be mid-write)

    expect(acquireCredentialLock(path, 222)).toEqual({ ok: false });
    expect(readFileSync(path, 'utf8')).toBe(''); // NOT reclaimed while it might be a lock in progress
  });

  it('acquireCredentialLock reclaims a null-pid lock once it is older than the creation grace', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, ''); // empty → null pid
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // backdate beyond the grace window → a genuinely orphaned empty lock

    expect(acquireCredentialLock(path, 222)).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('222');
  });

  it('acquireCredentialLock refuses while another reclaimer owns the guard', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');
    mkdirSync(`${path}.reclaim`);

    expect(acquireCredentialLock(path, 222, { isAlive: () => false })).toEqual({ ok: false });
    expect(readFileSync(path, 'utf8')).toBe('111');
  });

  it('acquireCredentialLock aborts the reclaim if a LIVE holder appears after the gate (staggered race)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111'); // a stale (dead) holder — passes the pre-gate stale check

    // Another cold-starter takes the lock with its own LIVE pid 999 in the window between our
    // stale-read and our post-gate re-inspection. The re-inspection must refuse, not stomp pid 999.
    const result = acquireCredentialLock(path, 222, {
      isAlive: (pid) => pid === 999,
      onReclaimGate: () => { unlinkSync(path); writeFileSync(path, '999', { flag: 'wx' }); },
    });

    expect(result).toEqual({ ok: false, heldBy: 999 });
    expect(readFileSync(path, 'utf8')).toBe('999'); // the fresh live claim was NOT overwritten
  });

  it('acquireCredentialLock reclaims when the holder that appears after the gate is itself dead', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    // A claimant 999 appears in the gate window but is itself dead → we may reclaim it and win.
    const result = acquireCredentialLock(path, 222, {
      isAlive: () => false,
      onReclaimGate: () => { unlinkSync(path); writeFileSync(path, '999', { flag: 'wx' }); },
    });

    expect(result).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('222');
  });

  it('acquireCredentialLock refuses (no stomp) when a fresh claimant wins the unlink→claim window (finding #1)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111'); // stale — we decide to reclaim

    // Model the exact #1 interleave: after we remove the stale lock but BEFORE our atomic claim, a
    // non-gated fresh acquirer lands its own claim. Our link() into the now-taken name then fails EEXIST
    // → refuse, so the two acquirers cannot BOTH get {ok:true}. A path write (truncate) would stomp 999.
    const result = acquireCredentialLock(path, 222, {
      isAlive: () => false,
      onReclaimGate: () => unlinkSync(path),                 // stale lock released before our re-inspect
      onBeforeClaim: () => writeFileSync(path, '999', { flag: 'wx' }), // fresh claimant wins the window
    });

    expect(result).toEqual({ ok: false });
    expect(readFileSync(path, 'utf8')).toBe('999'); // fresh claimant's file intact — not stomped
  });

  it('acquireCredentialLock refuses (no stomp) when the lock is replaced by a symlink under the gate', () => {
    const root = tempDir();
    const path = join(root, 'credential.lock');
    const secret = join(root, 'secret');
    writeFileSync(secret, 'FAKE_UNTOUCHED');
    writeFileSync(path, '111'); // stale

    const result = acquireCredentialLock(path, 222, {
      isAlive: () => false,
      onReclaimGate: () => { unlinkSync(path); symlinkSync(secret, path); }, // attacker plants a symlink
    });

    expect(result).toEqual({ ok: false });
    expect(lstatSync(path).isSymbolicLink()).toBe(true); // symlink not chased/removed
    expect(readFileSync(secret, 'utf8')).toBe('FAKE_UNTOUCHED'); // symlink target never written through
  });

  it('acquireCredentialLock refuses a foreign-owned lock through the euid seam', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    expect(acquireCredentialLock(path, 222, { euid: foreignEuid, isAlive: () => false })).toEqual({ ok: false });
  });

  it('releaseCredentialLock does not unlink a lock now held by a different pid', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111'); // we (pid 111) held it
    writeFileSync(path, '222'); // ...but it was reclaimed by 222 while we ran

    releaseCredentialLock(path, 111);

    expect(readFileSync(path, 'utf8')).toBe('222'); // 222's lock is NOT stranded by our release
  });

  it('ensureSecureDir creates a missing directory (and ancestors) at 0700', () => {
    const dir = join(tempDir(), 'a', 'b', 'configdir');

    ensureSecureDir(dir);

    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('ensureSecureDir forces the created directory to exactly 0o700 despite a restrictive umask', () => {
    const dir = join(tempDir(), 'forced'); // resolve tempDir BEFORE changing the umask
    const prevUmask = process.umask(0o100); // masks owner-EXECUTE from newly created directories
    try {
      ensureSecureDir(dir, { mode: 0o700 });
      // mkdir(0o700) under umask 0o100 lands as 0o600 — an un-enterable credential dir. finalizeCreatedDir
      // fchmod()s the dir fd to exactly 0o700 regardless of umask (the fd-based technique the file writer
      // uses). Without that fchmod this reads 0o600.
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(prevUmask);
    }
  });

  it('ensureSecureDir forces EVERY created level to 0o700 under an owner-execute-stripping umask (multi-level)', () => {
    // The qodo HIGH: a single `mkdir -p` under umask 0o100 would create the first ancestor un-enterable
    // (0o600, no owner-execute), so creating the rest of the path fails EACCES and strands a partial tree.
    // The per-level walk force-modes each component past umask on its own fd BEFORE descending, so all
    // three land at exactly 0o700 and the create succeeds. Resolve tempDir BEFORE changing the umask.
    const root = tempDir();
    const a = join(root, 'x');
    const b = join(a, 'y');
    const dir = join(b, 'z');
    const prevUmask = process.umask(0o100);
    try {
      ensureSecureDir(dir);
      for (const level of [a, b, dir]) {
        expect(statSync(level).isDirectory()).toBe(true);
        expect(statSync(level).mode & 0o777).toBe(0o700); // every created level enterable, not just the leaf
      }
    } finally {
      process.umask(prevUmask);
    }
  });

  it('ensureSecureDir rejects an owner-inaccessible mode (no owner-execute), creating nothing', () => {
    // A directory mode must grant the owner rwx or the credential dir cannot be entered/used. 0o600 clears
    // the group/other-writable guard but is still un-enterable — reject it at the door, before any create.
    const dir = join(tempDir(), 'ownerlocked');

    expect(() => ensureSecureDir(dir, { mode: 0o600 })).toThrow(/owner|rwx|mode/i);
    expect(existsSync(dir)).toBe(false);
  });

  it('ensureSecureDir rejects a created inode whose owner is not euid, and rolls the level back', () => {
    // finding iaci_/iacfd: the absent-create path must enforce the SAME euid-ownership invariant the
    // existing-dir path enforces, and must not strand a half-initialized level. With an injected foreign
    // euid the just-created inode (owned by the real euid) fails finalizeCreatedDir's ownership check; the
    // level is then rmdir'd so nothing partial is left for a later call to accept as "existing".
    const dir = join(tempDir(), 'wrongowner');

    expect(() => ensureSecureDir(dir, { euid: foreignEuid })).toThrow(/owner|owned/i);
    expect(existsSync(dir)).toBe(false); // rolled back — no partial-init directory left behind
  });

  it('ensureSecureDir accepts an existing 0755 directory without changing its mode', () => {
    const dir = join(tempDir(), 'profile');
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    ensureSecureDir(dir);

    // A legitimate group/other-READABLE (not writable) profile dir is accepted as-is and never chmodded,
    // exactly as secureWriteFile accepts a 0755 parent — a secret's own 0600 protects it, not dir traversal.
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('ensureSecureDir rejects a mode that would be group/other-writable, creating nothing', () => {
    const dir = join(tempDir(), 'loosemode');

    expect(() => ensureSecureDir(dir, { mode: 0o777 })).toThrow(/mode|writable/i);
    expect(existsSync(dir)).toBe(false); // rejected at the door → not created
  });

  it('ensureSecureDir rejects an existing symlinked directory', () => {
    const root = tempDir();
    const realDir = join(root, 'realdir');
    const linkDir = join(root, 'linkdir');
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkDir);

    expect(() => ensureSecureDir(linkDir)).toThrow(/symlink/i);
  });

  it('ensureSecureDir rejects an existing group/other-writable directory', () => {
    const dir = join(tempDir(), 'worldwritable');
    mkdirSync(dir);
    chmodSync(dir, 0o777);

    expect(() => ensureSecureDir(dir)).toThrow(/writable/i);
  });

  it('ensureSecureDir rejects a foreign-owned existing directory through the euid seam', () => {
    const dir = join(tempDir(), 'foreign');
    mkdirSync(dir, { mode: 0o700 });

    expect(() => ensureSecureDir(dir, { euid: foreignEuid })).toThrow(/owner|owned/i);
  });

  it('ensureSecureDir rejects a safe existing target under a group/other-writable parent (fast path validates the parent)', () => {
    const parent = join(tempDir(), 'loose-parent');
    mkdirSync(parent, { mode: 0o700 });
    const leaf = join(parent, 'creds');
    mkdirSync(leaf, { mode: 0o700 });
    chmodSync(leaf, 0o700); // the leaf itself is safe and euid-owned …
    chmodSync(parent, 0o777); // … but its immediate parent is group/other-writable

    // Without the fast-path parent check this pre-existing safe leaf would be accepted on a re-run, even
    // though the create path (first run) would have refused it under the loose ancestor — so refuse here too.
    expect(() => ensureSecureDir(leaf)).toThrow(/writable/i);
  });

  it('ensureSecureDir rejects a safe existing target reached through a symlinked parent (fast path)', () => {
    const realParent = join(tempDir(), 'real-parent');
    mkdirSync(realParent, { mode: 0o700 });
    mkdirSync(join(realParent, 'creds'), { mode: 0o700 });
    const linkParent = join(tempDir(), 'link-parent');
    symlinkSync(realParent, linkParent);

    // The leaf reached via the symlinked parent lstats as a real dir (the symlink is an ANCESTOR, not the
    // leaf), so only the fast-path parent check catches it — the immediate-parent analog of the create climb.
    expect(() => ensureSecureDir(join(linkParent, 'creds'))).toThrow(/symlink/i);
  });

  it('assertSecureDir accepts a safe existing directory and bubbles ENOENT for an absent one', () => {
    const dir = join(tempDir(), 'present');
    mkdirSync(dir, { mode: 0o700 });
    expect(() => assertSecureDir(dir)).not.toThrow();

    const absent = join(tempDir(), 'missing');
    let caught: NodeJS.ErrnoException | undefined;
    try { assertSecureDir(absent); } catch (err) { caught = err as NodeJS.ErrnoException; }
    expect(caught?.code).toBe('ENOENT'); // absent → natural not-found, so a caller can distinguish it
  });

  it('assertSecureDir rejects a symlinked or foreign-owned directory (validate-only, creates nothing)', () => {
    const root = tempDir();
    const realDir = join(root, 'realdir');
    const linkDir = join(root, 'linkdir');
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkDir);
    expect(() => assertSecureDir(linkDir)).toThrow(/symlink/i);

    expect(() => assertSecureDir(realDir, { euid: foreignEuid })).toThrow(/owner|owned/i);
  });
});
