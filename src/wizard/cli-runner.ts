import { spawnSync } from 'node:child_process';
import type { ProbeResult } from '../health/probe.js';

export type NativeProvider = 'claude' | 'codex' | 'cursor';

export interface CliRunner {
  login(provider: NativeProvider, env: NodeJS.ProcessEnv): void;
  status(provider: NativeProvider, env: NodeJS.ProcessEnv): ProbeResult;
}

// Exported so the argv contract is testable. Claude login uses `auth login` (NOT `setup-token`):
// `auth login` PERSISTS `.credentials.json` under CLAUDE_CONFIG_DIR, so a per-account config dir yields
// an isolated login; `setup-token` only PRINTS a token and stores nothing (it would leak the token to
// the operator's terminal and leave the account unauthenticated — HED-584). `--claudeai` pins the
// subscription flow (heddle rotation is subscription-quota) against a managed forceLoginMethod=console.
export const cliCommands: Record<NativeProvider, { command: string; login: string[]; status: string[] }> = {
  claude: { command: 'claude', login: ['auth', 'login', '--claudeai'], status: ['auth', 'status', '--json'] },
  codex: { command: 'codex', login: ['login'], status: ['login', 'status'] },
  cursor: { command: 'cursor-agent', login: ['login'], status: ['status', '--format', 'json'] },
};

export class NativeCliRunner implements CliRunner {
  login(provider: NativeProvider, env: NodeJS.ProcessEnv): void {
    const command = cliCommands[provider];
    // Interactive (browser/device) login — a generous cap so a truly hung login still aborts.
    // Route the child's STDOUT to our stderr (fd 2) so a machine-readable stdout — e.g. `heddle setup
    // --json` — stays clean of vendor login banners; stdin + stderr stay inherited so the interactive
    // login still shows its prompt/URL and can read the pasted token.
    const result = spawnSync(command.command, command.login, { env, stdio: ['inherit', 2, 'inherit'], timeout: 300_000 });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${command.command} login exited ${result.status}`);
  }

  status(provider: NativeProvider, env: NodeJS.ProcessEnv): ProbeResult {
    const command = cliCommands[provider];
    // Bounded: a status probe waiting on credentials/network must not block the wizard indefinitely.
    const result = spawnSync(command.command, command.status, { env, encoding: 'utf8', timeout: 20_000 });
    return {
      stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status,
      timedOut: result.signal === 'SIGTERM' || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    };
  }
}
