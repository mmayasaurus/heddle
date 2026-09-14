import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { useTempResources } from './helpers.js';
import { loadAccountRegistry } from '../src/accounts.js';

describe('heddle accounts', () => {
  const { tempDir } = useTempResources('heddle-cli-accounts-');

  function registry(name: string, value: unknown): string {
    const path = join(tempDir(), name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it('lists the unified registry as JSON', async () => {
    const accounts = registry('list.json', {
      schemaVersion: 2,
      claude: [{ id: 'primary', configDir: null, tier: 'T1', overage: { posture: 'bounded-prepaid', spendLimit: 39, creditsRemaining: 12 } }],
    });
    const result = await runCli(['accounts', 'list', '--json'], { env: { HEDDLE_ACCOUNTS: accounts } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      schemaVersion: 2,
      accounts: [expect.objectContaining({
        id: 'primary', provider: 'claude', credentialRef: 'claude:default', tier: 'T1',
        overage: { posture: 'bounded-prepaid', spendLimit: 39, creditsRemaining: 12 },
      })],
    }));
  });

  it('verifies local credential paths and treats logged-out Claude accounts as warnings', async () => {
    const configDir = join(tempDir(), 'claude-config');
    mkdirSync(configDir);
    const accounts = registry('verify.json', {
      claude: [{ id: 'logged-out', configDir, loggedIn: false }],
      codex: [{
        id: 'missing-path', codexHome: join(tempDir(), 'not-there'),
        overage: { posture: 'bounded-prepaid', spendLimit: 39, creditsRemaining: 12 },
      }],
    });
    const result = await runCli(['accounts', 'verify'], { env: { HEDDLE_ACCOUNTS: accounts } });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/WARN.*logged-out/i);
    expect(result.stdout).toMatch(/FAIL.*missing-path/i);
    expect(result.stdout).toContain('INFO  missing-path (codex): burning prepaid buffer $12 of $39 — rotate soon');
    expect(result.stdout).toMatch(/heddle doctor.*HED-399/i);
    expect(existsSync(configDir)).toBe(true);
  });

  it('adds an empty v2 registry from a non-interactive answer script', async () => {
    const answers = join(tempDir(), 'answers.json');
    const accounts = join(tempDir(), 'added.json');
    writeFileSync(answers, JSON.stringify(Array.from({ length: 16 }, () => false)));
    const result = await runCli(['accounts', 'add', '--answers', answers], { env: { HEDDLE_ACCOUNTS: accounts } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ added: [], failed: [], skipped: ['claude', 'codex', 'cursor'] });
    expect(loadAccountRegistry(accounts)).toEqual({ schemaVersion: 2, accounts: [] });
  });

  it('adds a GLM env-repoint account from a non-interactive answer script', async () => {
    const answers = join(tempDir(), 'glm-answers.json');
    const accounts = join(tempDir(), 'glm-added.json');
    writeFileSync(answers, JSON.stringify([true, 'glm-cli', 'global', '', 'CLI_GLM_TEST_KEY', 'paid', 'T1', false]));
    const result = await runCli(['accounts', 'add', '--provider', 'glm', '--answers', answers], {
      env: { HEDDLE_ACCOUNTS: accounts, CLI_GLM_TEST_KEY: 'FAKE_CLI_GLM_SENTINEL' },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ added: ['glm-cli'] });
    expect(loadAccountRegistry(accounts).accounts[0]).toMatchObject({
      provider: 'claude', envRepoint: { service: 'glm', authTokenRef: 'CLI_GLM_TEST_KEY' },
    });
    expect(`${result.stdout}\n${result.stderr}\n${readFileSync(accounts, 'utf8')}`).not.toContain('FAKE_CLI_GLM_SENTINEL');
  });
});
