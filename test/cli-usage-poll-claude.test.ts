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

  it('fails open when the strict registry loader rejects a registry the poll tolerates', async () => {
    // readClaudeAccounts tolerates a duplicate id (never throws), so the poll runs; the strict
    // loadAccountRegistry that HED-492 added throws on it. The identity reconcile must be SKIPPED,
    // never crash this launchd feeder or drop the report (HED-451 poller fail-open discipline).
    const root = tempDir();
    const accountsPath = join(root, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({
      claude: [
        { id: 'dup', configDir: '/x/a' },
        { id: 'dup', configDir: '/x/b' },
      ],
    }));
    const usageDir = join(root, 'usage');
    const result = await runCli(['usage', 'poll-claude', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.identity.error).toContain('duplicate');
    expect(parsed.identity.written).toEqual([]);
  });
});
