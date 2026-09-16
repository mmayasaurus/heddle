import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh fixture trust root; never use this to repair an existing application directory. */
export function createPrivateTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (process.platform !== 'win32') return root;
  try {
    // Preserve the native security tests' fixture contract independently of runner TEMP inheritance.
    // The directory is still empty. Child database directories are provisioned by production code.
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error('Windows private fixture requires SystemRoot');
    const result = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command',
        `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false);
        $p=[Console]::In.ReadLine(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
        $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid);
        $acl.SetAccessRuleProtection($true,$false);
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
        [IO.Directory]::SetAccessControl($p,$acl)`],
      { input: root + '\n', encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`Windows private fixture failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.status})`);
    }
    return root;
  } catch (error) {
    // A caller cannot track a root whose provisioning threw before this function returned.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    catch { /* Preserve the provisioning error. */ }
    throw error;
  }
}
