import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { childEnv, ensureBuilt, PROJECT_ROOT, runCli } from './helpers/cli.js';
import { writeAccountRegistry } from '../src/accounts.js';

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

  it.skipIf(process.platform === 'win32')('creates private first-run storage even under a permissive service umask', async () => {
    await ensureBuilt();
    const home = tempDir();
    const { env } = childEnv({ home });
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
      'import {pathToFileURL} from "node:url";process.umask(0o002);const cli=process.argv[1];process.argv=[process.execPath,cli,"usage","poll-claude","--json"];await import(pathToFileURL(cli).href);',
      join(PROJECT_ROOT, 'dist', 'cli.js')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(child.status, child.stderr).toBe(0);
    const root = join(home, '.heddle');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'usage')).mode & 0o777).toBe(0o700);
    expect(() => writeAccountRegistry({ schemaVersion: 2, accounts: [] }, join(root, 'accounts.json'))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('continues polling into a legacy POSIX usage directory without changing its permissions', async () => {
    const home = tempDir(), usageDir = join(home, 'usage');
    mkdirSync(usageDir);
    chmodSync(usageDir, 0o775);
    const result = await runCli(['usage', 'poll-claude', '--json'], { home, env: { HEDDLE_USAGE_DIR: usageDir } });
    expect(result.code, result.stderr).toBe(0);
    expect(statSync(usageDir).mode & 0o777).toBe(0o775);
  });

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
