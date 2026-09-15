import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAccountRegistry } from '../src/accounts.js';
import { runAccountsAdd } from '../src/wizard/accounts-add.js';
import { ScriptedPrompter } from '../src/wizard/prompt.js';
import type { CliRunner } from '../src/wizard/cli-runner.js';
import { useTempResources } from './helpers.js';

const marker = 'fakefakefakefake';
const fakeRunner: CliRunner = {
  login: () => undefined,
  status: () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: marker, exitCode: 0, timedOut: false }),
};

describe('accounts add wizard', () => {
  const { tempDir } = useTempResources('heddle-accounts-add-test-');

  it('records one Claude subscription account without exposing a vendor secret', async () => {
    const path = join(tempDir(), 'claude.json');
    const transcript: string[] = [];
    const summary = await runAccountsAdd({ provider: 'claude', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'paid', 'T2', false, false]), runner: fakeRunner,
      now: () => new Date('2026-09-13T00:00:00.000Z'), report: (line) => transcript.push(line),
    });
    expect(summary).toEqual({ added: ['claude-1'], failed: [], skipped: [] });
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      id: 'claude-1', provider: 'claude', billingClass: 'subscription-quota', tier: 'T2', loggedIn: true,
    });
    expect(`${transcript.join('\n')}\n${readFileSync(path, 'utf8')}`).not.toContain(marker);
  });

  it('persists each additional account before continuing the provider loop', async () => {
    const path = join(tempDir(), 'two.json');
    await runAccountsAdd({ provider: 'claude', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'first', 'paid', 'T1', true, 'second', 'paid', 'T2', false, false]), runner: fakeRunner,
    });
    const accounts = loadAccountRegistry(path).accounts;
    expect(accounts.map((account) => account.id)).toEqual(['first', 'second']);
    expect(new Set(accounts.map((account) => account.configDir)).size).toBe(2);
  });

  it('writes a valid empty v2 registry when all providers are declined', async () => {
    const path = join(tempDir(), 'empty.json');
    const summary = await runAccountsAdd({ registryPath: path }, {
      prompter: new ScriptedPrompter(Array.from({ length: 16 }, () => false)), runner: fakeRunner,
    });
    expect(summary).toEqual({ added: [], failed: [], skipped: ['claude', 'codex', 'cursor'] });
    expect(existsSync(path)).toBe(true);
    expect(loadAccountRegistry(path)).toEqual({ schemaVersion: 2, accounts: [] });
  });

  it('records a Cursor account as a machine-login row (keyFile null) so rotation can use it', async () => {
    const path = join(tempDir(), 'cursor.json');
    const summary = await runAccountsAdd({ provider: 'cursor', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'work', 'paid', 'T1', false, false]), runner: fakeRunner,
    });
    expect(summary.added).toEqual(['work']);
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      id: 'work', provider: 'cursor', keyFile: null, credentialRef: 'cursor:default',
    });
  });

  it('rejects a path-traversal account id', async () => {
    const path = join(tempDir(), 'evil.json');
    await expect(runAccountsAdd({ provider: 'claude', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '../../escape']), runner: fakeRunner,
    })).rejects.toThrow(/invalid account id/);
  });

  it('strips inherited Anthropic creds from the claude onboarding env, keeping only CLAUDE_CONFIG_DIR (HED-585)', async () => {
    const home = tempDir();
    const path = join(home, 'sanitize.json');
    const captured: { login?: NodeJS.ProcessEnv; status?: NodeJS.ProcessEnv; envDuringLogin?: Record<string, string | undefined> } = {};
    const capturingRunner: CliRunner = {
      login: (_provider, env) => {
        captured.login = { ...env };
        // Snapshot the LIVE process.env during the call — proves accountEnv copied it, never mutated it.
        captured.envDuringLogin = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
      },
      status: (_provider, env) => {
        captured.status = { ...env };
        return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false };
      },
    };
    // Ambient credentials that would let `auth status` report logged-in from an INHERITED identity.
    // Synthetic, deliberately NOT credential-shaped (no sk-ant- prefix) — shipped test files are scanned.
    const ambient: Record<string, string> = {
      ANTHROPIC_API_KEY: 'inherited-key-must-not-leak', ANTHROPIC_AUTH_TOKEN: 'inherited-auth-must-not-leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'inherited-oauth-must-not-leak', ANTHROPIC_PROFILE: 'inherited-work',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_FEDERATION_RULE_ID: 'fed-1',
      ANTHROPIC_ORGANIZATION_ID: 'org-1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(ambient)) { saved[key] = process.env[key]; process.env[key] = value; }
    try {
      await runAccountsAdd({ provider: 'claude', registryPath: path, homeDir: home }, {
        prompter: new ScriptedPrompter([true, 'iso', 'paid', 'T2', false, false]), runner: capturingRunner,
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const expectedConfigDir = join(home, '.heddle', 'accounts', 'claude', 'iso');
    for (const env of [captured.login, captured.status]) {
      expect(env).toBeDefined();
      expect(env?.CLAUDE_CONFIG_DIR).toBe(expectedConfigDir);
      for (const key of Object.keys(ambient)) expect(env).not.toHaveProperty(key);
    }
    // accountEnv copies process.env — during the call the live env still carried every ambient value
    // (proves non-mutation without depending on post-cleanup state, which a real CI env could hold).
    expect(captured.envDuringLogin).toEqual(ambient);
  });

  it('strips inherited claude creds case-insensitively — a Windows mixed-case key would otherwise survive (HED-585)', async () => {
    const home = tempDir();
    const path = join(home, 'case.json');
    const captured: { login?: NodeJS.ProcessEnv } = {};
    const capturingRunner: CliRunner = {
      login: (_provider, env) => { captured.login = { ...env }; },
      status: () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false }),
    };
    // Lower/mixed-case spellings: case-insensitive on Windows, so a fixed-case delete would miss them.
    const mixed: Record<string, string> = {
      anthropic_api_key: 'lower-must-not-leak', Anthropic_Auth_Token: 'mixed-must-not-leak',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(mixed)) { saved[key] = process.env[key]; process.env[key] = value; }
    try {
      await runAccountsAdd({ provider: 'claude', registryPath: path, homeDir: home }, {
        prompter: new ScriptedPrompter([true, 'mc', 'paid', 'T2', false, false]), runner: capturingRunner,
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    for (const key of Object.keys(mixed)) expect(captured.login).not.toHaveProperty(key);
  });

  it('echoes the signed-in identity on the claude PASS line, never a token field (HED-585)', async () => {
    const home = tempDir();
    const path = join(home, 'identity.json');
    const transcript: string[] = [];
    const runner: CliRunner = {
      login: () => undefined,
      status: () => ({
        stdout: JSON.stringify({
          loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max',
          accessToken: 'token-value-MUST-NOT-APPEAR',
        }),
        stderr: '', exitCode: 0, timedOut: false,
      }),
    };
    await runAccountsAdd({ provider: 'claude', registryPath: path, homeDir: home }, {
      prompter: new ScriptedPrompter([true, 'acct', 'paid', 'T2', false, false]), runner,
      report: (line) => transcript.push(line),
    });
    const pass = transcript.find((line) => line.startsWith('PASS claude acct'));
    expect(pass).toBe('PASS claude acct — dev@example.com · Example Org · max');
    expect(transcript.join('\n')).not.toContain('MUST-NOT-APPEAR');
  });

  it('leaves the claude PASS line bare when the status output carries no identity', async () => {
    const home = tempDir();
    const path = join(home, 'noid.json');
    const transcript: string[] = [];
    // fakeRunner reports { loggedIn: true } with no email → loginIdentity returns undefined.
    await runAccountsAdd({ provider: 'claude', registryPath: path, homeDir: home }, {
      prompter: new ScriptedPrompter([true, 'acct', 'paid', 'T2', false, false]), runner: fakeRunner,
      report: (line) => transcript.push(line),
    });
    expect(transcript).toContain('PASS claude acct');
  });
});
