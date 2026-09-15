import { describe, expect, it } from 'vitest';
import { cliCommands } from '../src/wizard/cli-runner.js';

describe('cli-runner command table', () => {
  it('signs claude in with `auth login` (persists creds), never `setup-token` (only prints one) — HED-584', () => {
    // `claude setup-token` opens the browser flow, PRINTS a one-year token, and stores nothing — it would
    // leak the token to the operator's terminal and leave the per-account dir unauthenticated. `auth login`
    // writes .credentials.json under CLAUDE_CONFIG_DIR; --claudeai pins the subscription (not console) flow.
    expect(cliCommands.claude.login).toEqual(['auth', 'login', '--claudeai']);
    expect(cliCommands.claude.login).not.toContain('setup-token');
    expect(cliCommands.claude.status).toEqual(['auth', 'status', '--json']);
  });

  it('leaves the codex and cursor login/status commands unchanged', () => {
    expect(cliCommands.codex).toEqual({ command: 'codex', login: ['login'], status: ['login', 'status'] });
    expect(cliCommands.cursor).toEqual({ command: 'cursor-agent', login: ['login'], status: ['status', '--format', 'json'] });
  });
});
