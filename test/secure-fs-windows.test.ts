import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireCredentialLock, assertSecureDir, ensureSecureDir, releaseCredentialLock, secureReadFile, secureWriteFile } from '../src/secure-fs.js';
import { assertWindowsPrivateFile, createWindowsPrivateFile, windowsSecureFs } from '../src/secure-fs-windows.js';
import { createPrivateTempRoot } from './helpers/private-temp.js';

const nativeWindows = process.platform === 'win32';
const transport = vi.hoisted(() => ({ active: false, calls: [] as unknown[][], response: {} as object }));
vi.mock('node:child_process', async (importActual) => {
  const real = await importActual<typeof import('node:child_process')>();
  return { ...real, spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
    if (!transport.active) return real.spawnSync(...args);
    transport.calls.push(args);
    return transport.response;
  } };
});

describe('Windows secure filesystem transport', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', descriptor);
    transport.active = false;
    transport.calls.length = 0;
    vi.unstubAllEnvs();
  });

  it('uses native validation even when the caller supplies a POSIX euid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    transport.active = true;
    transport.response = { status: 0, stdout: JSON.stringify({ ok: true, content: Buffer.from('FAKE_NATIVE_SECRET').toString('base64') }), stderr: '' };
    expect(secureReadFile('C:\\Users\\test\\credential', { euid: 0 })).toBe('FAKE_NATIVE_SECRET');
    expect(transport.calls).toHaveLength(1);
  });

  it('keeps secret writes in stdin and discards subprocess diagnostics on failure', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    transport.active = true;
    transport.response = { status: 1, stdout: 'FAKE_SECRET_SENTINEL', stderr: 'FAKE_SECRET_SENTINEL' };
    expect(() => secureWriteFile('C:\\Users\\test\\credential', 'FAKE_SECRET_SENTINEL')).toThrow(/Windows secure filesystem/);
    expect(JSON.stringify(transport.calls[0]?.slice(0, 2))).not.toContain('FAKE_SECRET_SENTINEL');
    try { secureWriteFile('C:\\Users\\test\\credential', 'FAKE_SECRET_SENTINEL'); }
    catch (error) { expect(String(error)).not.toContain('FAKE_SECRET_SENTINEL'); }
  });

  it('keeps the write payload out of argv and limits the helper environment', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('ANTHROPIC_API_KEY', 'FAKE_INHERITED_SECRET');
    vi.stubEnv('TEMP', 'C:\\foreign-temp');
    vi.stubEnv('TMP', 'C:\\foreign-temp');
    transport.active = true;
    transport.response = { status: 0, stdout: '{"ok":true}', stderr: '' };
    secureWriteFile('C:\\Users\\test\\credential', 'FAKE_SECRET_SENTINEL');
    const [command, args, options] = transport.calls[0] as [string, string[], { input: string; env: object }];
    expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const inputFormat = args.indexOf('-InputFormat');
    expect(args.slice(inputFormat, inputFormat + 2)).toEqual(['-InputFormat', 'None']);
    expect(inputFormat).toBeLessThan(args.indexOf('-File'));
    expect(args.join(' ')).not.toContain('FAKE_SECRET_SENTINEL');
    expect(JSON.parse(options.input).content).toBe(Buffer.from('FAKE_SECRET_SENTINEL').toString('base64'));
    expect(JSON.stringify(options.env)).not.toContain('FAKE_INHERITED_SECRET');
    expect(options.env).toEqual({ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
  });

  it('reports a validated recovery filename without trusting arbitrary diagnostic fields', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    transport.active = true;
    const recoveryFile = '.0123456789abcdef0123456789abcdef.tmp';
    transport.response = { status: 0, stdout: JSON.stringify({ ok: false, code: 'EIO', reason: 'RECOVERY', recoveryFile }), stderr: '' };
    expect(() => secureWriteFile('C:\\Users\\test\\credential', 'FAKE_SECRET')).toThrow(`recovery file retained in credential directory: ${recoveryFile}`);
    transport.response = { status: 0, stdout: JSON.stringify({ ok: false, code: 'EIO', reason: 'RECOVERY', recoveryFile: 'FAKE_SECRET_BAD_DIAGNOSTIC' }), stderr: '' };
    try { secureWriteFile('C:\\Users\\test\\credential', 'FAKE_SECRET'); }
    catch (error) { expect(String(error)).not.toContain('FAKE_SECRET_BAD_DIAGNOSTIC'); }
  });

  it('refuses malformed replies and missing read or lock metadata without leaking response fields', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    transport.active = true;
    for (const stdout of ['not JSON', 'null', '[]', '{}', '{"ok":"true"}']) {
      transport.response = { status: 0, stdout };
      expect(() => windowsSecureFs('read', 'C:\\private\\file')).toThrow(/invalid response/);
    }
    transport.response = { status: 0, stdout: '{"ok":true}' };
    expect(() => windowsSecureFs('read', 'C:\\private\\file')).toThrow(/invalid read response/);
    for (const mtimeMs of [null, '1', undefined]) {
      transport.response = { status: 0, stdout: JSON.stringify({ ok: true, content: '', mtimeMs }) };
      expect(() => windowsSecureFs('inspect-lock', 'C:\\private\\file')).toThrow(/invalid lock metadata/);
    }
    for (const content of [null, 1, { secret: 'FAKE_SECRET' }]) {
      transport.response = { status: 0, stdout: JSON.stringify({ ok: true, content }) };
      expect(() => windowsSecureFs('assert-dir', 'C:\\private')).toThrow(/invalid response/);
    }
    for (const reason of ['FAKE_SECRET', 'toString', '__proto__', { toString: 'FAKE_SECRET' }]) {
      transport.response = { status: 0, stdout: JSON.stringify({ ok: false, code: 'FAKE_SECRET', reason }) };
      expect(() => windowsSecureFs('read', 'C:\\private\\file')).toThrowError(expect.objectContaining({ code: 'EIO', message: 'Windows secure filesystem: operation failed' }));
    }
  });
});

// These exercise actual NTFS ACLs/handles. POSIX mode-bit assertions belong in secure-fs.test.ts.
describe.skipIf(!nativeWindows)('Windows native credential filesystem', () => {
  let tempRoot: string;
  let root: string;
  const powershell = (script: string, path: string): string => {
    const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadLine(); ' + script],
      { input: path + '\n', encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Windows ACL test fixture failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.status}): ${result.stderr}`);
    return result.stdout.trim();
  };
  const grantEveryone = (path: string, rights = 'Read'): void => {
    powershell(`$acl=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'${rights}','Allow');
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`, path);
  };
  const invokeWithPublicationFault = (destination: string, call: string, fault: string) => {
    const helper = readFileSync(fileURLToPath(new URL('../assets/secure-fs-windows.ps1', import.meta.url)), 'utf8');
    expect(helper.split(call)).toHaveLength(2); // exactly one native call is altered, never silently missed
    const injected = join(root, 'fault-injected-helper.ps1');
    writeFileSync(injected, helper.replace(call, fault));
    const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-File', injected], {
        input: JSON.stringify({ operation: 'write', path: destination, requireOwner: true, content: Buffer.from('FAKE_NEW_SECRET').toString('base64') }) + '\n',
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('FAKE_NEW_SECRET');
    return JSON.parse(result.stdout) as { ok: boolean; reason?: string; code?: string; recoveryFile?: string };
  };
  beforeEach(() => {
    tempRoot = createPrivateTempRoot('heddle-win-secure-');
    root = join(tempRoot, 'private');
    ensureSecureDir(root);
  });
  afterEach(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('creates private nested directories and replaces a credential with Unicode bytes intact', () => {
    const file = join(root, 'private', 'nested', 'credential');
    secureWriteFile(file, 'FAKE_OLD');
    secureWriteFile(file, 'FAKE_🔒_SECRET\n');
    expect(secureReadFile(file)).toBe('FAKE_🔒_SECRET\n');
    assertSecureDir(dirname(file));
    const acl = JSON.parse(powershell(`$a=Get-Acl -LiteralPath $p;
      @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
        sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
        protected=$a.AreAccessRulesProtected;
        allowed=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress`, file));
    expect(acl.owner).toBe(acl.sid);
    expect(acl.protected).toBe(true);
    expect(acl.allowed).toEqual([acl.sid]);
  }, 60_000);

  it('preserves ENOENT for absent file and directory', () => {
    expect(() => secureReadFile(join(root, 'absent'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(() => assertSecureDir(join(root, 'absent'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('requires a private directory for database children and creates a private file exclusively', () => {
    const directory = join(root, 'database');
    ensureSecureDir(directory);
    const file = join(directory, 'empty.sqlite');
    createWindowsPrivateFile(file, '');
    const writer = openSync(file, 'r+');
    try { assertWindowsPrivateFile(file); } finally { closeSync(writer); }
    expect(() => createWindowsPrivateFile(file, 'FAKE_OVERWRITE')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(file, 'utf8')).toBe('');
    grantEveryone(directory, 'ReadAndExecute');
    expect(() => ensureSecureDir(directory)).toThrow(/ACL/);
    expect(() => assertSecureDir(directory)).toThrow(/ACL/);
  }, 60_000);

  it('refuses a private directory whose ACL does not propagate to native child files', () => {
    const directory = join(root, 'non-inheriting');
    ensureSecureDir(directory);
    powershell(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid);
      $acl.SetAccessRuleProtection($true,$false);
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));
      [IO.Directory]::SetAccessControl($p,$acl)`, directory);
    expect(() => ensureSecureDir(directory)).toThrow(/inherit/i);
    expect(() => assertSecureDir(directory)).toThrow(/inherit/i);
  }, 60_000);

  it('retains private recovery bytes after a simulated ReplaceFile 1176 partial failure', () => {
    const destination = join(root, 'credential');
    secureWriteFile(destination, 'FAKE_OLD_SECRET');
    const call = '[IO.File]::Replace($temporary, $path, $null)';
    const fault = `[IO.File]::Delete($path); throw [IO.IOException]::new('simulated ERROR_UNABLE_TO_MOVE_REPLACEMENT', ${0x80070000 | 1176})`;
    const response = invokeWithPublicationFault(destination, call, fault);
    expect(response).toMatchObject({ ok: false, reason: 'RECOVERY', code: 'EIO' });
    expect(response.recoveryFile).toMatch(/^\.[a-f0-9]{32}\.tmp$/);
    expect(existsSync(destination)).toBe(false); // model the documented partial failure, not a normal failed replace
    const recovery = join(root, response.recoveryFile!);
    expect(secureReadFile(recovery)).toBe('FAKE_NEW_SECRET'); // real helper validates the surviving file's ACL
  }, 60_000);

  it('replaces a private peer that wins initial publication without a recovery error', () => {
    const destination = join(root, 'credential');
    const move = '[IO.File]::Move($temporary, $path)';
    // Deterministically publish a peer after the absent-target check, then execute the REAL native Move.
    // Its actual EEXIST must take the validated replacement path, not a fabricated success response.
    const response = invokeWithPublicationFault(destination, move,
      `Create-PrivateFile $path ([Text.Encoding]::UTF8.GetBytes('FAKE_PEER_SECRET')); ${move}`);
    expect(response).toEqual({ ok: true });
    expect(secureReadFile(destination)).toBe('FAKE_NEW_SECRET');
    expect(readdirSync(root).filter((name) => /^\.[a-f0-9]{32}\.tmp$/.test(name))).toEqual([]);
  }, 60_000);

  it('refuses an unsafe peer that wins initial publication and retains private recovery bytes', () => {
    const destination = join(root, 'credential');
    const move = '[IO.File]::Move($temporary, $path)';
    const response = invokeWithPublicationFault(destination, move, `
      Create-PrivateFile $path ([Text.Encoding]::UTF8.GetBytes('FAKE_PEER_SECRET'));
      $peerAcl=[IO.File]::GetAccessControl($path);
      $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
      $peerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'));
      [IO.File]::SetAccessControl($path,$peerAcl);
      ${move}`);
    expect(response).toMatchObject({ ok: false, code: 'EACCES', reason: 'RECOVERY' });
    expect(readFileSync(destination, 'utf8')).toBe('FAKE_PEER_SECRET');
    expect(() => secureReadFile(destination)).toThrow(/ACL/);
    expect(response.recoveryFile).toMatch(/^\.[a-f0-9]{32}\.tmp$/);
    expect(secureReadFile(join(root, response.recoveryFile!))).toBe('FAKE_NEW_SECRET');
  }, 60_000);

  it('does not retry publication for an unrelated sharing violation even when a private peer exists', () => {
    const destination = join(root, 'credential');
    const response = invokeWithPublicationFault(destination, '[IO.File]::Move($temporary, $path)',
      `Create-PrivateFile $path ([Text.Encoding]::UTF8.GetBytes('FAKE_PEER_SECRET'));
       throw [IO.IOException]::new('simulated sharing violation', ${0x80070000 | 32})`);
    expect(response).toMatchObject({ ok: false, code: 'EBUSY', reason: 'RECOVERY' });
    expect(secureReadFile(destination)).toBe('FAKE_PEER_SECRET');
    expect(secureReadFile(join(root, response.recoveryFile!))).toBe('FAKE_NEW_SECRET');
  }, 60_000);

  it('refuses a foreign read grant even with caller euid/mode overrides, leaving old bytes intact', () => {
    const file = join(root, 'credential');
    secureWriteFile(file, 'FAKE_OLD');
    grantEveryone(file);
    expect(() => secureReadFile(file, { euid: 0 })).toThrow(/ACL/);
    expect(() => secureWriteFile(file, 'FAKE_NEW', { euid: 0, mode: 0o600 })).toThrow(/ACL/);
    expect(readFileSync(file, 'utf8')).toBe('FAKE_OLD');
  }, 60_000);

  it('refuses a null DACL instead of treating an empty grant enumeration as private', () => {
    const file = join(root, 'credential');
    secureWriteFile(file, 'FAKE_OLD');
    powershell(`$a=Get-Acl -LiteralPath $p; $a.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL',[Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $p -AclObject $a`, file);
    expect(() => secureReadFile(file)).toThrow(/ACL/);
    expect(() => secureWriteFile(file, 'FAKE_NEW')).toThrow(/ACL/);
  }, 60_000);

  it('rejects a foreign owner even if its DACL permits only the current user', (context) => {
    const admin = powershell(`$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());
      $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`, root);
    // Assigning Administrators ownership needs an elevated token. ACL rejection tests run for all users.
    if (admin !== 'True') { context.skip(); return; }
    const file = join(root, 'credential');
    secureWriteFile(file, 'FAKE_OLD');
    powershell(`$a=Get-Acl -LiteralPath $p; $a.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));
      Set-Acl -LiteralPath $p -AclObject $a`, file);
    expect(() => secureReadFile(file, { euid: 0 })).toThrow(/ownership/);
    expect(() => secureWriteFile(file, 'FAKE_NEW', { euid: 0 })).toThrow(/ownership/);
  }, 60_000);

  it('refuses a tamperable parent but allows foreign directory read-only access', () => {
    const parent = join(root, 'profile');
    ensureSecureDir(parent);
    grantEveryone(parent, 'ReadAndExecute');
    secureWriteFile(join(parent, 'credential'), 'FAKE_SECRET');
    grantEveryone(parent, 'Modify');
    expect(() => secureReadFile(join(parent, 'credential'))).toThrow(/ACL/);
    expect(() => secureWriteFile(join(parent, 'other'), 'FAKE_SECRET')).toThrow(/ACL/);
    expect(existsSync(join(parent, 'other'))).toBe(false);
  }, 60_000);

  it('rejects a junction parent and an opted-in junction ancestor', () => {
    const real = join(root, 'real');
    ensureSecureDir(join(real, 'nested'));
    const link = join(root, 'junction');
    symlinkSync(real, link, 'junction');
    expect(() => secureWriteFile(join(link, 'credential'), 'FAKE_SECRET')).toThrow(/reparse/);
    expect(() => ensureSecureDir(join(link, 'nested', 'leaf'), { boundary: root })).toThrow(/reparse/);
    expect(existsSync(join(real, 'nested', 'leaf'))).toBe(false);
  }, 60_000);

  it('rejects device names, alternate streams, and traversal aliases before creating anything', () => {
    for (const name of ['NUL', 'credential:stream', 'trailing.', 'trailing ']) {
      expect(() => secureWriteFile(join(root, name), 'FAKE_SECRET')).toThrow(/path/);
    }
    expect(() => ensureSecureDir(root + '\\missing\\..\\leaf', { boundary: root })).toThrow(/traversal|path/);
  });

  it('retains the live holder, refuses wrong-pid release, and permits owner release', () => {
    const lock = join(root, 'credential.lock');
    expect(acquireCredentialLock(lock)).toEqual({ ok: true });
    expect(acquireCredentialLock(lock)).toEqual({ ok: false, heldBy: process.pid });
    releaseCredentialLock(lock, process.pid + 1);
    expect(existsSync(lock)).toBe(true);
    releaseCredentialLock(lock);
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it('does not reclaim or release a lock with unsafe ACLs', () => {
    const lock = join(root, 'credential.lock');
    expect(acquireCredentialLock(lock)).toEqual({ ok: true });
    grantEveryone(lock, 'FullControl');
    expect(acquireCredentialLock(lock, process.pid + 1, { isAlive: () => false })).toEqual({ ok: false });
    releaseCredentialLock(lock);
    expect(existsSync(lock)).toBe(true);
  }, 60_000);

  it('re-inspects a stale lock after taking the reclaim gate', () => {
    const lock = join(root, 'credential.lock');
    secureWriteFile(lock, '1234');
    const outcome = acquireCredentialLock(lock, 5678, {
      isAlive: (pid) => pid === process.pid,
      onReclaimGate: () => secureWriteFile(lock, String(process.pid)),
    });
    expect(outcome).toEqual({ ok: false, heldBy: process.pid });
    expect(secureReadFile(lock)).toBe(String(process.pid));
  }, 60_000);

  it('never stomps a fresh claimant in the stale unlink-to-claim window', () => {
    const lock = join(root, 'credential.lock');
    secureWriteFile(lock, '1234');
    const outcome = acquireCredentialLock(lock, 5678, {
      isAlive: (pid) => pid === process.pid,
      onBeforeClaim: () => expect(acquireCredentialLock(lock)).toEqual({ ok: true }),
    });
    expect(outcome).toEqual({ ok: false });
    expect(secureReadFile(lock)).toBe(String(process.pid));
  }, 60_000);

  it('backs off a fresh malformed lock and reclaims it only after the creation grace', () => {
    const lock = join(root, 'credential.lock');
    secureWriteFile(lock, 'garbage');
    // Keep this inside the grace even on a slow Windows runner launching several helper processes.
    const fresh = new Date(Date.now() + 60_000);
    utimesSync(lock, fresh, fresh);
    expect(acquireCredentialLock(lock)).toEqual({ ok: false });
    utimesSync(lock, new Date(0), new Date(0));
    expect(acquireCredentialLock(lock)).toEqual({ ok: true });
  }, 60_000);

  it('admits exactly one native process during simultaneous stale-lock takeover', async () => {
    const lock = join(root, 'credential.lock');
    secureWriteFile(lock, 'malformed');
    utimesSync(lock, new Date(0), new Date(0));
    // CI builds first: each child loads the actual emitted module and invokes the native ACL helper.
    const moduleUrl = pathToFileURL(join(process.cwd(), 'dist', 'secure-fs.js')).href;
    const start = Date.now() + 3000;
    const children: ReturnType<typeof spawn>[] = [];
    const run = (): Promise<{ ok: boolean }> => new Promise((resolve, reject) => {
      const script = `import { acquireCredentialLock } from ${JSON.stringify(moduleUrl)};
        setTimeout(() => { try {
          const result = acquireCredentialLock(${JSON.stringify(lock)});
          process.stdout.write(JSON.stringify(result) + '\\n');
          if (result.ok) setTimeout(() => {}, 20000);
        } catch { process.exitCode = 1; } }, Math.max(0, ${start} - Date.now()));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let output = '';
      child.on('error', reject);
      child.stdout!.on('data', (data) => {
        output += String(data);
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); }
          catch { reject(new Error('Invalid lock worker response')); }
        }
      });
      child.on('exit', (code) => { if (code !== 0 || !output.includes('\n')) reject(new Error('Lock worker failed')); });
    });
    try {
      const results = await Promise.all([run(), run(), run()]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    } finally {
      await Promise.all(children.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        child.kill();
      })));
    }
  }, 60_000);
});
