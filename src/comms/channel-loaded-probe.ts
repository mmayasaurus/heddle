import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Best-effort check for the Claude Code development-channel launcher flag. This is deliberately
 * fail-open: only a clear Claude invocation without the heddle-comms entry returns false.
 */
export function channelLoadedFromParentArgv(
  ppid: number,
  readArgv: (ppid: number) => string | null = readParentArgv,
): boolean | null {
  if (!Number.isInteger(ppid) || ppid <= 0) return null;
  let argv: string | null;
  try {
    argv = readArgv(ppid);
  } catch {
    return null;
  }
  if (!argv?.trim() || !looksLikeClaude(argv)) return null;

  const flag = /(?:^|\s)--dangerously-load-development-channels(?:=([^\s]+)|\s+([^\s]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = flag.exec(argv)) !== null) {
    const value = match[1] ?? match[2];
    if (!value || value.startsWith('--')) continue;
    if (/(^|:)heddle-comms($|@)/.test(value)) return true;
  }
  return false;
}

function looksLikeClaude(argv: string): boolean {
  return /(?:^|\s)(?:[^\s]*\/)?claude(?:\s|$)/.test(argv);
}

function readParentArgv(ppid: number): string | null {
  try {
    return readFileSync(`/proc/${ppid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    try {
      // Inputs are a fixed arg vector + a validated integer pid (no injection surface).
      return execFileSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(ppid)], { encoding: 'utf8' });
    } catch {
      return null;
    }
  }
}
