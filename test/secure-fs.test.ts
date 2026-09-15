import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('secureWriteFile does not copy a pre-existing target’s permissive mode', () => {
    const path = join(tempDir(), 'credential');
    writeFileSync(path, 'FAKE_OLD_SECRET');
    chmodSync(path, 0o644);

    secureWriteFile(path, 'FAKE_SECRET_SENTINEL');

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

    expect(() => secureWriteFile(path, 'FAKE_SECRET_SENTINEL', { euid: foreignEuid })).toThrow(/owner|owned/i);
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

  it('acquireCredentialLock claims a free path', () => {
    const path = join(tempDir(), 'locks', 'credential.lock');

    expect(acquireCredentialLock(path, 12345)).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('12345');
    releaseCredentialLock(path);
  });

  it('acquireCredentialLock refuses a live holder and names it', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    expect(acquireCredentialLock(path, 222, { isAlive: () => true })).toEqual({ ok: false, heldBy: 111 });
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

  it('acquireCredentialLock aborts the reclaim if a live holder appears after the gate (staggered race)', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111'); // a stale (dead) holder — we pass the pre-gate stale check

    // Simulate another cold-starter fully reclaiming (writing its own LIVE pid 999) in the window
    // between our stale-read and our post-gate re-check. The re-check must refuse, not stomp pid 999.
    const result = acquireCredentialLock(path, 222, {
      isAlive: (pid) => pid === 999,
      onReclaimGate: () => writeFileSync(path, '999'),
    });

    expect(result).toEqual({ ok: false, heldBy: 999 });
    expect(readFileSync(path, 'utf8')).toBe('999'); // the fresh live claim was NOT overwritten
  });

  it('acquireCredentialLock refuses a foreign-owned lock through the euid seam', () => {
    const path = join(tempDir(), 'credential.lock');
    writeFileSync(path, '111');

    expect(acquireCredentialLock(path, 222, { euid: foreignEuid, isAlive: () => false })).toEqual({ ok: false });
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
