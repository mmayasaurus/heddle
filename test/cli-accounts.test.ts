import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { useTempResources } from './helpers.js';

describe('heddle accounts', () => {
  const { tempDir } = useTempResources('heddle-cli-accounts-');

  function registry(name: string, value: unknown): string {
    const path = join(tempDir(), name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it('lists the unified registry as JSON', async () => {
    const accounts = registry('list.json', { schemaVersion: 2, claude: [{ id: 'primary', configDir: null, tier: 'T1' }] });
    const result = await runCli(['accounts', 'list', '--json'], { env: { HEDDLE_ACCOUNTS: accounts } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      schemaVersion: 2,
      accounts: [expect.objectContaining({ id: 'primary', provider: 'claude', credentialRef: 'claude:default', tier: 'T1' })],
    }));
  });

  it('verifies local credential paths and treats logged-out Claude accounts as warnings', async () => {
    const configDir = join(tempDir(), 'claude-config');
    mkdirSync(configDir);
    const accounts = registry('verify.json', {
      claude: [{ id: 'logged-out', configDir, loggedIn: false }],
      codex: [{ id: 'missing-path', codexHome: join(tempDir(), 'not-there') }],
    });
    const result = await runCli(['accounts', 'verify'], { env: { HEDDLE_ACCOUNTS: accounts } });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/WARN.*logged-out/i);
    expect(result.stdout).toMatch(/FAIL.*missing-path/i);
    expect(result.stdout).toMatch(/heddle doctor.*HED-399/i);
    expect(existsSync(configDir)).toBe(true);
  });
});
