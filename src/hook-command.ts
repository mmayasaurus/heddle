import { parseAddress } from './comms/address.js';

/** Render a native hook command without interpreting paths or arguments as shell code. */
export function hookCommand(argv: string[], platform: NodeJS.Platform = process.platform): string {
  if (!argv.length || argv.some((value) => value.includes('\0'))) throw new Error('invalid hook command arguments');
  if (platform !== 'win32') return argv.map((value) => `'${value.replace(/'/g, `'"'"'`)}'`).join(' ');
  // Client hook runners differ between cmd.exe and PowerShell. This outer command is valid in both;
  // encode the fixed PowerShell invocation so neither outer shell can expand paths or metacharacters.
  const script = `# heddle-fleet-hook-v1\n$ErrorActionPreference='Stop'\ntry { & ${argv.map((value) => `'${value.replace(/'/g, "''")}'`).join(' ')}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine('Heddle hook could not start'); exit 1 }`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat None -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/** Match this install's full command and a valid prior agent; preserve foreign marker-bearing hooks. */
export function isHeddleHookCommand(command: string, argvPrefix: string[]): boolean {
  const marker = '__HEDDLE_AGENT__';
  const source = (value: string): string => {
    const encoded = /^powershell\.exe -NoLogo -NoProfile -NonInteractive(?: -InputFormat None)? -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/.exec(value)?.[1];
    return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : value;
  };
  for (const platform of ['linux', 'win32'] as const) {
    const template = source(hookCommand([...argvPrefix, marker, '--heddle-fleet-hook'], platform));
    const at = template.lastIndexOf(marker), prefix = template.slice(0, at), suffix = template.slice(at + marker.length);
    const candidate = source(command);
    if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) continue;
    const agent = candidate.slice(prefix.length, -suffix.length);
    if (agent === '' || parseAddress(agent)?.kind === 'agent') return true;
  }
  return false;
}
