import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { runCli } from './helpers/cli.js';

describe('heddle usage poll-claude CLI', () => {
  const { tempDir } = useTempResources('heddle-cli-poll-claude-');

  function accountsFixture(): { accountsPath: string; usageDir: string } {
    const root = tempDir();
    const accountsPath = join(root, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({
      claude: [
        { id: 'acct1', configDir: '/x/acct1' },
        { id: 'acct2', configDir: '/x/acct2' },
      ],
    }));
    const usageDir = join(root, 'usage');
    return { accountsPath, usageDir };
  }

  function oauthSidecars(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.oauth-usage.json'));
  }

  it('exits non-zero and writes no sidecar for an unknown --account id', async () => {
    const { accountsPath, usageDir } = accountsFixture();
    const result = await runCli(['usage', 'poll-claude', '--account', 'missing'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('heddle usage poll-claude: no registry account with id "missing"');
    expect(oauthSidecars(usageDir)).toEqual([]);
  });
});
