import { spawnSync } from 'node:child_process';
import type { ProbeResult } from '../health/probe.js';

export type NativeProvider = 'claude' | 'codex' | 'cursor';

export interface CliRunner {
  login(provider: NativeProvider, env: NodeJS.ProcessEnv): void;
  status(provider: NativeProvider, env: NodeJS.ProcessEnv): ProbeResult;
}

const commands: Record<NativeProvider, { command: string; login: string[]; status: string[] }> = {
  claude: { command: 'claude', login: ['setup-token'], status: ['auth', 'status', '--json'] },
  codex: { command: 'codex', login: ['login'], status: ['login', 'status'] },
  cursor: { command: 'cursor-agent', login: ['login'], status: ['status', '--format', 'json'] },
};

export class NativeCliRunner implements CliRunner {
  login(provider: NativeProvider, env: NodeJS.ProcessEnv): void {
    const command = commands[provider];
    const result = spawnSync(command.command, command.login, { env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${command.command} login exited ${result.status}`);
  }

  status(provider: NativeProvider, env: NodeJS.ProcessEnv): ProbeResult {
    const command = commands[provider];
    const result = spawnSync(command.command, command.status, { env, encoding: 'utf8' });
    return {
      stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status, timedOut: result.signal === 'SIGTERM',
    };
  }
}
