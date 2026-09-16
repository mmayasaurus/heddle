import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

/**
 * Windows PowerShell 5.1 supplies the .NET Framework ACL APIs without a native npm dependency.
 * Secret write bytes travel only over stdin; read bytes return over a captured private pipe. Never
 * attach child output/errors as an Error cause: PowerShell diagnostics can echo the input document.
 * SID/DACL checks always run natively; POSIX euid/mode seams cannot override them.
 */
type WindowsOperation = 'read' | 'write' | 'create-file' | 'assert-private-file' | 'assert-dir' | 'ensure-dir' | 'inspect-lock';
interface WindowsResult {
  content?: string;
  mtimeMs?: number;
}
const reasons: Record<string, string> = {
  ACL: 'unsafe ACL or foreign ownership',
  REPARSE: 'reparse point (symlink or junction)',
  TYPE: 'unexpected filesystem object type',
  PATH: 'unsupported or ambiguous path',
  BOUNDARY: 'boundary is not an ancestor of the credential directory',
  INHERITANCE: 'private directory ACL must inherit current-user FullControl into files and directories',
  RECOVERY: 'publication failed; a private recovery file was retained; inspect the credential directory before retrying',
  IO: 'operation failed',
};

export function windowsSecureFs(
  operation: WindowsOperation,
  path: string,
  options: { content?: string; boundary?: string; requireOwner?: boolean } = {},
): WindowsResult {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
    throw new Error('Windows secure filesystem requires an absolute SystemRoot');
  }
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('../assets/secure-fs-windows.ps1', import.meta.url));
  const request = {
    operation, path,
    ...(options.content === undefined ? {} : { content: Buffer.from(options.content, 'utf8').toString('base64') }),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
    requireOwner: options.requireOwner ?? true,
  };
  const child = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    // No provider credentials or user PowerShell profile in the ACL helper's environment.
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  if (child.error || child.status !== 0) throw new Error('Windows secure filesystem helper failed');
  let result: { ok?: boolean; code?: string; reason?: string; content?: string; mtimeMs?: number; recoveryFile?: string };
  try {
    result = JSON.parse(child.stdout.replace(/^\uFEFF/, '').trim());
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error();
  } catch {
    throw new Error('Windows secure filesystem helper returned an invalid response');
  }
  if (!result.ok) {
    // The helper generates this basename internally. Only that narrow format may reach diagnostics;
    // never surface an arbitrary child-provided path or exception message beside credential failures.
    const recovery = result.reason === 'RECOVERY' && typeof result.recoveryFile === 'string' && /^\.[a-f0-9]{32}\.tmp$/.test(result.recoveryFile)
      ? `; recovery file retained in credential directory: ${result.recoveryFile}` : '';
    const error: NodeJS.ErrnoException = new Error(`Windows secure filesystem: ${reasons[result.reason ?? ''] ?? reasons.IO}${recovery}`);
    error.code = ['ENOENT', 'EEXIST', 'EACCES', 'EBUSY', 'EINVAL', 'EIO'].includes(result.code ?? '') ? result.code : 'EIO';
    throw error;
  }
  if ((operation === 'read' || operation === 'inspect-lock') && typeof result.content !== 'string') {
    throw new Error('Windows secure filesystem helper returned an invalid read response');
  }
  if (operation === 'inspect-lock' && (typeof result.mtimeMs !== 'number' || !Number.isFinite(result.mtimeMs))) {
    throw new Error('Windows secure filesystem helper returned invalid lock metadata');
  }
  return {
    ...(result.content === undefined ? {} : { content: Buffer.from(result.content, 'base64').toString('utf8') }),
    ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
  };
}

/** Validate a database or sidecar through an open file handle without copying any of its bytes. */
export function assertWindowsPrivateFile(path: string): void {
  windowsSecureFs('assert-private-file', path);
}

/** Create with a private DACL before writing any bytes; EEXIST is never an overwrite permission. */
export function createWindowsPrivateFile(path: string, content: string): void {
  windowsSecureFs('create-file', path, { content });
}
