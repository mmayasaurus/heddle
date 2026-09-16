import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapComms } from '../src/comms/bootstrap.js';
import { CommsLog } from '../src/comms/log.js';
import { initOperatorToken, operatorTokenMatches } from '../src/comms/server.js';
import { loadAccountRegistry, writeAccountRegistry } from '../src/accounts.js';
import { secureReadFile, acquireCredentialLock, releaseCredentialLock } from '../src/secure-fs.js';
import { useTempResources } from './helpers.js';

describe('native platform persistent fleet storage', () => {
  const { tempDir } = useTempResources('heddle-platform-storage-');

  it('creates comms storage, preserves its token on rerun, and rotates the trust root on request', () => {
    const root = join(tempDir(), 'Heddle data 🧶');
    const options = { commsDbPath: join(root, 'comms.db'), operatorTokenPath: join(root, 'operator.token'), projectsPath: join(root, 'projects.json') };
    expect(bootstrapComms(options).operatorToken.action).toBe('created');
    const before = secureReadFile(options.operatorTokenPath).trim();
    expect(before).toMatch(/^[a-f0-9]{48}$/);
    expect(bootstrapComms(options).operatorToken.action).toBe('kept');
    expect(secureReadFile(options.operatorTokenPath).trim()).toBe(before);
    expect(operatorTokenMatches({ HEDDLE_COMMS_OPERATOR_TOKEN: before }, options.operatorTokenPath)).toBe(true);
    expect(initOperatorToken({ path: options.operatorTokenPath, rotate: true }).action).toBe('rotated');
    expect(operatorTokenMatches({ HEDDLE_COMMS_OPERATOR_TOKEN: before }, options.operatorTokenPath)).toBe(false);
    const log = new CommsLog(options.commsDbPath, { readOnly: true });
    try { expect(log.room('#fleet')).not.toBeNull(); } finally { log.close(); }
  });

  it('persists the account registry and excludes a second credential operation while locked', () => {
    const root = join(tempDir(), 'account data');
    const path = join(root, 'accounts.json');
    writeAccountRegistry({ schemaVersion: 2, accounts: [] }, path);
    expect(loadAccountRegistry(path)).toEqual({ schemaVersion: 2, accounts: [] });
    const lock = join(root, 'accounts.lock');
    expect(acquireCredentialLock(lock)).toEqual({ ok: true });
    try { expect(acquireCredentialLock(lock)).toEqual({ ok: false, heldBy: process.pid }); }
    finally { releaseCredentialLock(lock); }
    expect(acquireCredentialLock(lock)).toEqual({ ok: true });
    releaseCredentialLock(lock);
  });
});
