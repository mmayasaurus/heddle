import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapComms } from '../src/comms/bootstrap.js';
import { CommsLog } from '../src/comms/log.js';
import { initOperatorToken, operatorTokenMatches } from '../src/comms/server.js';
import { loadAccountRegistry, writeAccountRegistry } from '../src/accounts.js';
import { secureReadFile, secureWriteFile, acquireCredentialLock, releaseCredentialLock } from '../src/secure-fs.js';
import { useTempResources } from './helpers.js';
import { Ledger } from '../src/ledger.js';
import { DEFAULT_MAX_STREAM_BYTES } from '../src/adapters/subprocess.js';
import { windowsPowerShellFixtureEnv } from './helpers/private-temp.js';

describe('native platform persistent fleet storage', () => {
  const { tempDir } = useTempResources('heddle-platform-storage-', { privateWindowsRoot: true });
  const grantWindowsEveryoneRead = (path: string): void => {
    const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', `$ErrorActionPreference='Stop';
        [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); $p=[Console]::In.ReadLine();
        $acl=Get-Acl -LiteralPath $p; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')));
        Set-Acl -LiteralPath $p -AclObject $acl`],
      { input: path + '\n', encoding: 'utf8', timeout: 30_000, windowsHide: true, env: windowsPowerShellFixtureEnv() });
    if (result.error || result.status !== 0) throw new Error('Windows ACL fixture failed');
  };

  it('persists a complete worker output at the subprocess stream limit', () => {
    const ledger = new Ledger(join(tempDir(), 'large-output', 'ledger.db'));
    try {
      const id = ledger.start({ orchestrator: 'codex-test', taskClass: 'implementation', provider: 'codex', model: 'test',
        skills: 'worker-role', issue: 'HED-639', pr: null, cwd: '.', promptPreview: 'large output', sessionId: null, fellBackFrom: null });
      const output = 'x'.repeat(DEFAULT_MAX_STREAM_BYTES);
      ledger.finish(id, { ok: true, output });
      expect(ledger.get(id)?.output_path).toBe(`${id}.md`);
      expect(ledger.getWithOutput(id)?.output).toBe(output);
    } finally { ledger.close(); }
  });

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

  it('treats operator token read errors as a failed match', () => {
    expect(operatorTokenMatches({ HEDDLE_COMMS_OPERATOR_TOKEN: 'FAKE_TOKEN' }, tempDir())).toBe(false);
  });

  it.runIf(process.platform === 'win32')('refuses an unsafe Windows database even for readonly comms access', () => {
    const path = join(tempDir(), 'readonly', 'comms.db');
    new CommsLog(path).close();
    const before = readFileSync(path);
    grantWindowsEveryoneRead(path);
    expect(() => new CommsLog(path, { readOnly: true })).toThrow(/ACL/);
    expect(readFileSync(path)).toEqual(before);
    expect(() => secureReadFile(path)).toThrow(/ACL/); // validation did not silently repair the grant
  }, 60_000);

  it.runIf(process.platform === 'win32')('validates the private parent and existing sidecars on readonly comms access', () => {
    for (const target of ['parent', 'sidecar']) {
      const parent = join(tempDir(), 'readonly');
      const path = join(parent, 'comms.db');
      new CommsLog(path).close();
      const unsafe = target === 'parent' ? parent : `${path}-wal`;
      if (target === 'sidecar') secureWriteFile(unsafe, 'FAKE_WAL');
      grantWindowsEveryoneRead(unsafe);
      expect(() => new CommsLog(path, { readOnly: true })).toThrow(/ACL/);
    }
  }, 60_000);

  it.runIf(process.platform === 'win32')('does not provision absent readonly Windows comms storage', () => {
    const parent = join(tempDir(), 'absent');
    expect(() => new CommsLog(join(parent, 'comms.db'), { readOnly: true })).toThrow();
    expect(existsSync(parent)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('returns false for an unsafe Windows operator-token ACL or unavailable helper', () => {
    const path = join(tempDir(), 'private', 'operator.token');
    secureWriteFile(path, 'FAKE_OPERATOR_TOKEN');
    const env = { HEDDLE_COMMS_OPERATOR_TOKEN: 'FAKE_OPERATOR_TOKEN' };
    expect(operatorTokenMatches(env, path)).toBe(true);
    vi.stubEnv('SystemRoot', '');
    try { expect(operatorTokenMatches(env, path)).toBe(false); }
    finally { vi.unstubAllEnvs(); }
    grantWindowsEveryoneRead(path);
    expect(operatorTokenMatches(env, path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('FAKE_OPERATOR_TOKEN');
    expect(() => secureReadFile(path)).toThrow(/ACL/);
  }, 60_000);
});
