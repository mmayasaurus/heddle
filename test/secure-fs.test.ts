import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireCredentialLock,
  releaseCredentialLock,
  secureReadFile,
  secureWriteFile,
  withCredentialLock,
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

  it('acquireCredentialLock rejects an invalid pid rather than writing a self-reclaimable holder', () => {
    // NaN / 0 / fractional would be written then read back as unreadable/dead → instantly reclaimable by
    // a second live caller, so both "hold" it. Reject at the door instead.
    const path = join(tempDir(), 'credential.lock');

    expect(() => acquireCredentialLock(path, Number.NaN)).toThrow(/invalid pid/i);
    expect(() => acquireCredentialLock(path, 0)).toThrow(/invalid pid/i);
    expect(() => acquireCredentialLock(path, 1.5)).toThrow(/invalid pid/i);
    expect(existsSync(path)).toBe(false);
  });

  it('acquireCredentialLock refuses a live holder and names it', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    expect(acquireCredentialLock(path, 222, { isAlive: () => true })).toEqual({ ok: false, heldBy: 111 });
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

  it('acquireCredentialLock refuses (no stomp) when a fresh wx claimant wins the unlink→claim window (finding #1)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111'); // stale — we decide to reclaim

    // Model the exact #1 interleave: after we remove the stale lock but BEFORE our O_EXCL claim, a
    // non-gated fresh acquirer lands its own claim. Our 'wx' must then fail EEXIST → refuse, so the two
    // acquirers cannot BOTH get {ok:true}. A 'w' (truncate) here would stomp 999 and dual-acquire.
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

  it('withCredentialLock runs its function under the lock and releases afterward', () => {
    const path = join(tempDir(), 'credential.lock');

    const result = withCredentialLock(path, () => {
      expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
      return 'done';
    });

    expect(result).toBe('done');
    expect(existsSync(path)).toBe(false);
  });

  it('withCredentialLock releases afterward when its function throws', () => {
    const path = join(tempDir(), 'credential.lock');

    expect(() => withCredentialLock(path, () => { throw new Error('FAKE_FAILURE'); })).toThrow('FAKE_FAILURE');
    expect(existsSync(path)).toBe(false);
  });
});
