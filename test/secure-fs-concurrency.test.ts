import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * HED-626 concurrency: ensureSafeParent's absent-parent branch now uses the non-recursive per-level walk
 * (createSecureDirTree), which throws EEXIST when a concurrent same-uid process wins the create race. The
 * OLD recursive `mkdir` tolerated that race — but BLINDLY (a peer that created the parent group/other-
 * writable was accepted with no re-validation). ensureSafeParent retries the whole validate-or-create so
 * the peer's directory is RE-VALIDATED, never blindly adopted: race-tolerant AND tightening.
 *
 * This file is isolated (its own vi.mock of node:fs) so the real-fs suite in secure-fs.test.ts is
 * untouched. The mock wraps ONLY mkdirSync and only for the planned sentinel path — the peer "wins" that
 * one mkdir (creating the dir at its chosen mode, one-shot) and our call loses with EEXIST, exercising the
 * retry. Every other fs call passes through to the real implementation.
 */

// Shared between the hoisted mock factory and the test bodies. Key = the exact dir path createSecureDirTree
// will mkdir; value = the mode the racing peer creates it at. One-shot (deleted on first fire).
const racePlan = vi.hoisted(() => new Map<string, { mode: number }>());

vi.mock('node:fs', async (importActual) => {
  const real = await importActual<typeof import('node:fs')>();
  const mkdirSync = ((p: unknown, opts?: unknown) => {
    const key = typeof p === 'string' ? p : String(p);
    const peer = racePlan.get(key);
    if (peer) {
      racePlan.delete(key); // one-shot: only the FIRST attempt loses; the retry's mkdir passes through
      real.mkdirSync(key, opts as Parameters<typeof real.mkdirSync>[1]);
      real.chmodSync(key, peer.mode); // mkdir's mode is umask-masked; force the peer's exact mode
      const err: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, mkdir '${key}'`);
      err.code = 'EEXIST';
      throw err; // our mkdir loses the race
    }
    return real.mkdirSync(p as Parameters<typeof real.mkdirSync>[0], opts as Parameters<typeof real.mkdirSync>[1]);
  }) as typeof real.mkdirSync;
  return { ...real, mkdirSync };
});

// Imported AFTER the (hoisted) mock is registered, so secure-fs's `import { mkdirSync } from 'node:fs'`
// resolves to the wrapped version.
const { acquireCredentialLock, releaseCredentialLock, secureWriteFile } = await import('../src/secure-fs.js');

describe('secure-fs concurrency — ensureSafeParent tolerates a raced parent create (HED-626)', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-secure-fs-conc-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    racePlan.clear();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    dirs.length = 0;
  });

  it('acquireCredentialLock tolerates a concurrent SAFE parent create and claims cleanly (no caller euid)', () => {
    const parent = join(tempDir(), 'locks'); // absent → createSecureDirTree will mkdir it
    const lockPath = join(parent, 'cred.lock');
    racePlan.set(parent, { mode: 0o700 }); // a peer wins the create race, safely

    // The lock passes NO euid (module invariant). The losing mkdir throws EEXIST inside createSecureDirTree;
    // ensureSafeParent must retry, re-validate the peer's 0o700 dir, and reach a clean atomic claim.
    const result = acquireCredentialLock(lockPath);
    expect(result.ok).toBe(true);
    expect(racePlan.has(parent)).toBe(false); // the race ACTUALLY fired — guards against a vacuous mock
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    releaseCredentialLock(lockPath);
  });

  it('acquireCredentialLock RE-VALIDATES a raced parent and REFUSES an unsafe (group/other-writable) one', () => {
    const parent = join(tempDir(), 'locks');
    const lockPath = join(parent, 'cred.lock');
    racePlan.set(parent, { mode: 0o777 }); // a peer wins the race but creates it world-writable

    // Retry must RE-VALIDATE, not blindly adopt: 0o777 is rejected, so the lock refuses rather than claiming
    // inside a world-writable dir. This is the tightening the old race-tolerant recursive mkdir lacked.
    expect(() => acquireCredentialLock(lockPath)).toThrow(/writable/i);
    expect(racePlan.has(parent)).toBe(false); // the race fired
  });

  it('secureWriteFile tolerates a concurrent SAFE parent create and writes the secret', () => {
    const path = join(tempDir(), 'raceparent', 'credential');
    racePlan.set(dirname(path), { mode: 0o700 });

    secureWriteFile(path, 'FAKE_SECRET_SENTINEL');
    expect(racePlan.has(dirname(path))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('FAKE_SECRET_SENTINEL');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
