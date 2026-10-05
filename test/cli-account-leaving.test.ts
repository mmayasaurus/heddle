import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { accountFixture, type AccountFixtureOptions, type FixtureAccount } from './helpers/account-fixture.js';
import { ensureBuilt, runCli, withTempHome } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-cli-account-leaving-test-');

function fixture(accounts: FixtureAccount[], used: Record<string, number>, options?: AccountFixtureOptions) {
  return accountFixture(tempDir(), accounts, used, options);
}

describe('heddle account pick --leaving (a switch pick for one running session)', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  // The live registry's shape: acct2 and acct4 are two folders logged into one login, and the default
  // folder (no registry row) is logged into acct1's.
  const registry = [
    { id: 'acct1', configDir: '/tmp/acct1', accountUuid: 'LOGIN-1' },
    { id: 'acct2', configDir: '/tmp/acct2', accountUuid: 'LOGIN-2' },
    { id: 'acct3', configDir: '/tmp/acct3', accountUuid: 'LOGIN-3' },
    { id: 'acct4', configDir: '/tmp/acct4', accountUuid: 'LOGIN-2' },
  ];
  /** A temp HOME whose `.claude.json` (the default folder's) is logged into `accountUuid`. */
  const homeLoggedInto = (accountUuid?: string) => {
    const home = withTempHome();
    if (accountUuid) writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid } }));
    return home;
  };
  const run = (args: string[], usage: { accountsPath: string; usageDir: string }, home: string, census: string[] = []) =>
    runCli(['account', 'pick', ...args], {
      home,
      env: { HEDDLE_ACCOUNTS: usage.accountsPath, HEDDLE_USAGE_DIR: usage.usageDir, HEDDLE_CENSUS_PS_FIXTURE: JSON.stringify(census) },
    });

  it('regression — leaving the default folder skips its login, though an account on that login has the most room', async () => {
    const usage = fixture(registry, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 });
    const result = await run(['--leaving', 'default', '--json'], usage, homeLoggedInto('LOGIN-1'));
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      account: 'acct2', configDir: '/tmp/acct2', unsetConfigDir: false,
      usedPct5h: 30, usedPct7d: null, bindingMeter: '5h', resetsAt: null,
      roomPct: 70, residents: 0,
      reason: 'account:acct2 switch pick (room 70%; 0 session(s) there; its folders at most 5h 30%, 7d unknown; best of 2 login(s))',
    });
  }, 30_000);

  it('names the login by account id or config folder, and takes the login\'s other folders with it', async () => {
    const usage = fixture(registry, { acct1: 5, acct2: 1, acct3: 50, acct4: 1 });
    const home = homeLoggedInto('LOGIN-1');
    for (const leaving of ['acct4', '/tmp/acct2', '/tmp/acct2/']) {
      const result = await run(['--leaving', leaving, '--json'], usage, home);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ account: 'acct1', roomPct: 95 });
    }
  }, 60_000);

  it('shares each login\'s room with the sessions the census finds on it, whichever folder they run in', async () => {
    const usage = fixture(registry, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 });
    const home = homeLoggedInto('LOGIN-1');
    // Leaving acct3: alone, LOGIN-1 (95% room) beats LOGIN-2 (70%).
    expect(JSON.parse((await run(['--leaving', 'acct3', '--json'], usage, home)).stdout)).toMatchObject({ account: 'acct1', residents: 0 });
    // Two sessions on LOGIN-1 (one in its registered folder, one in the default folder) leave 95 ÷ 3 per seat;
    // the session on acct4 counts toward LOGIN-2, leaving 70 ÷ 2 — still more.
    const census = ['claude CLAUDE_CONFIG_DIR=/tmp/acct1', 'claude', 'claude CLAUDE_CONFIG_DIR=/tmp/acct4'];
    const result = await run(['--leaving', 'acct3', '--json'], usage, home, census);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ account: 'acct2', residents: 1 });
  }, 60_000);

  it('counts a 5h window resetting within 30 minutes as empty, read through the real limits.json path', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const home = homeLoggedInto('LOGIN-1');
    const soon = fixture(registry, { acct1: 10, acct2: 80, acct3: 40, acct4: 80 }, {
      resetsAt: { acct2: { fiveHour: nowS + 10 * 60 }, acct4: { fiveHour: nowS + 10 * 60 } },
    });
    const picked = await run(['--leaving', 'default', '--json'], soon, home);
    expect(JSON.parse(picked.stdout)).toMatchObject({ account: 'acct2', roomPct: 100, usedPct5h: 80 });
    expect(JSON.parse(picked.stdout).reason).toContain('resetting within 30 min');

    const later = fixture(registry, { acct1: 10, acct2: 80, acct3: 40, acct4: 80 }, {
      resetsAt: { acct2: { fiveHour: nowS + 60 * 60 }, acct4: { fiveHour: nowS + 60 * 60 } },
    });
    expect(JSON.parse((await run(['--leaving', 'default', '--json'], later, home)).stdout)).toMatchObject({ account: 'acct3', roomPct: 60 });

    // 14% left is too little to carry a session to the reset, however soon it comes.
    const nearlyFull = fixture(registry, { acct1: 10, acct2: 86, acct3: 40, acct4: 86 }, {
      resetsAt: { acct2: { fiveHour: nowS + 10 * 60 }, acct4: { fiveHour: nowS + 10 * 60 } },
    });
    expect(JSON.parse((await run(['--leaving', 'default', '--json'], nearlyFull, home)).stdout)).toMatchObject({ account: 'acct3', roomPct: 60 });
  }, 60_000);

  it('prints the pick and, with --explain, every account', async () => {
    const usage = fixture(registry, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 });
    const result = await run(['--leaving', 'default', '--explain'], usage, homeLoggedInto('LOGIN-1'));
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const [selected, ...details] = result.stdout.trim().split('\n');
    expect(selected).toMatch(/^acct2 {2}CLAUDE_CONFIG_DIR=\/tmp\/acct2 {2}account:acct2 switch pick/);
    expect(details).toEqual([
      'acct1: 5h 5%, 7d unknown, headroom 95% (5h binds), login being left',
      'acct2: 5h 30%, 7d unknown, headroom 70% (5h binds), eligible',
      'acct3: 5h 50%, 7d unknown, headroom 50% (5h binds), eligible',
      'acct4: 5h 30%, 7d unknown, headroom 70% (5h binds), eligible',
    ]);

    const json = await run(['--leaving', 'default', '--json', '--explain'], usage, homeLoggedInto('LOGIN-1'));
    expect(JSON.parse(json.stdout).accounts.map((row: { account: string; leaving: boolean }) => [row.account, row.leaving]))
      .toEqual([['acct1', true], ['acct2', false], ['acct3', false], ['acct4', false]]);
  }, 30_000);

  it('names an overage account as such in --explain, not eligible', async () => {
    const overage = registry.map((account) => (account.id === 'acct3' ? { ...account, overageEnabled: true } : account));
    const result = await run(['--leaving', 'default', '--explain'], fixture(overage, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 }), homeLoggedInto('LOGIN-1'));
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('acct3: 5h 50%, 7d unknown, headroom 50% (5h binds), overage\n');
  }, 30_000);

  it('regression — says which sibling folder took a login out, in --explain and its JSON', async () => {
    // Overage on acct4 takes out its login, acct2's too: acct2 must not read as eligible.
    const overage = registry.map((account) => (account.id === 'acct4' ? { ...account, overageEnabled: true } : account));
    const usage = fixture(overage, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 });
    const text = await run(['--leaving', 'default', '--explain'], usage, homeLoggedInto('LOGIN-1'));
    expect(text).toMatchObject({ code: 0, stderr: '' });
    expect(text.stdout).toMatch(/^acct3 /);
    expect(text.stdout).toContain('acct2: 5h 30%, 7d unknown, headroom 70% (5h binds), login ruled out by acct4 (overage)\n');
    expect(text.stdout).toContain('acct4: 5h 30%, 7d unknown, headroom 70% (5h binds), overage');
    const json = JSON.parse((await run(['--leaving', 'default', '--json', '--explain'], usage, homeLoggedInto('LOGIN-1'))).stdout);
    expect(json.accounts.find((row: { account: string }) => row.account === 'acct2').ruledOutBy).toEqual({ account: 'acct4', state: 'overage' });
    // Leaving that login, its folders say what takes it out too.
    const leaving = await run(['--leaving', 'acct2', '--explain'], usage, homeLoggedInto('LOGIN-1'));
    expect(leaving).toMatchObject({ code: 0, stderr: '' });
    expect(leaving.stdout).toContain('acct2: 5h 30%, 7d unknown, headroom 70% (5h binds), login being left, login ruled out by acct4 (overage)\n');
  }, 30_000);

  it('refuses with exit 1 when no other login has a usable account', async () => {
    const usage = fixture(registry, { acct1: 99, acct2: 10, acct3: 98, acct4: 10 });
    const result = await run(['--leaving', 'acct2'], usage, homeLoggedInto('LOGIN-1'));
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toMatch(/refusing a switch pick: no other login has a usable account: 2 account\(s\) on the login being left, 2 on logins ruled out/);
  }, 30_000);

  it('regression — never picks an account whose own folder caches a stale id for its email', async () => {
    const home = withTempHome();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'CURRENT', emailAddress: 'one@example.com' } }));
    const stale = join(tempDir(), '.claude-acct1');
    mkdirSync(stale);
    writeFileSync(join(stale, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'OLD', emailAddress: 'one@example.com' } }));
    const usage = fixture([
      { id: 'acct1', configDir: stale, email: 'one@example.com' },
      { id: 'acct2', configDir: '/tmp/acct2', email: 'two@example.com' },
    ], { acct1: 10, acct2: 60 });
    const result = await run(['--leaving', 'default', '--explain'], usage, home);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const [selected, ...details] = result.stdout.trim().split('\n');
    expect(selected).toMatch(/^acct2 /);
    expect(details[0]).toMatch(/^acct1: .*, login unknown$/);
  }, 30_000);

  it('regression — leaving the default folder skips a registry row that knows the same login only by email', async () => {
    const home = withTempHome();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'LOGIN-1', emailAddress: 'one@example.com' } }));
    const usage = fixture([
      { id: 'acct1', configDir: '/tmp/acct1', email: 'one@example.com' },
      { id: 'acct2', configDir: '/tmp/acct2', email: 'two@example.com' },
    ], { acct1: 10, acct2: 60 });
    const result = await run(['--leaving', 'default', '--json', '--explain'], usage, home);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ account: 'acct2', roomPct: 40 });
    expect(parsed.accounts.map((row: { account: string; leaving: boolean }) => [row.account, row.leaving]))
      .toEqual([['acct1', true], ['acct2', false]]);
  }, 30_000);

  it('exits 2 when --leaving has no value, names no login, or comes with a multi-agent --for', async () => {
    const usage = fixture(registry, { acct1: 5, acct2: 30, acct3: 50, acct4: 30 });
    const home = homeLoggedInto('LOGIN-1');
    for (const args of [['--leaving'], ['--leaving', '--json']]) {
      const result = await run(args, usage, home);
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toMatch(/usage: heddle account pick .*--leaving/);
    }
    const nowhere = await run(['--leaving', '/tmp/no-such-config-folder'], usage, home);
    expect(nowhere).toMatchObject({ code: 2, stdout: '' });
    expect(nowhere.stderr).toMatch(/cannot decide a switch pick: \/tmp\/no-such-config-folder names no login/);
    // The default folder names no login when its .claude.json holds none.
    const loggedOutHome = await run(['--leaving', 'default'], usage, homeLoggedInto());
    expect(loggedOutHome).toMatchObject({ code: 2, stdout: '' });
    const batch = await run(['--leaving', 'default', '--for', 'A,B'], usage, home);
    expect(batch).toMatchObject({ code: 2, stdout: '' });
    expect(batch.stderr).toMatch(/--leaving picks for one session/);
  }, 90_000);
});
