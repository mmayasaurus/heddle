import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  installUsagePollLaunchd,
  renderUsagePollPlist,
  USAGE_POLL_LABEL,
} from '../src/usage-poll-launchd.js';

const homes: string[] = [];
const home = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'heddle-usage-poll-launchd-'));
  homes.push(path);
  return path;
};
const plistIn = (root: string): string => join(root, 'Library', 'LaunchAgents', `${USAGE_POLL_LABEL}.plist`);

// Deps that let a real install write into a temp home while never touching real launchctl.
const noKeeper = (root: string, extra: Record<string, unknown> = {}) => ({
  homeDir: root,
  uid: 501,
  nodeBin: '/resolved/node',
  cliJs: '/resolved/cli.js',
  env: {},
  isKeeperLoaded: () => false,
  bootout: () => {},
  bootstrap: () => {},
  ...extra,
});

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('renderUsagePollPlist', () => {
  test('renders the poll command, interval, and log paths with XML escaping', () => {
    const plist = renderUsagePollPlist({
      nodeBin: '/node&<bin>',
      cliJs: '/cli&<file>',
      homeDir: '/home&<dir>',
      startIntervalSecs: 300,
    });

    expect(plist).toContain(`<string>${USAGE_POLL_LABEL}</string>`);
    expect(plist).toContain('<string>/node&amp;&lt;bin&gt;</string>\n    <string>/cli&amp;&lt;file&gt;</string>\n    <string>usage</string>\n    <string>poll-claude</string>');
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('/home&amp;&lt;dir&gt;/.heddle/usage-poll-claude.launchd.log');
    expect(plist).toContain('/home&amp;&lt;dir&gt;/.heddle/usage-poll-claude.launchd.err');
    expect(plist).not.toContain('/home&<dir>');
  });

  test('omits EnvironmentVariables when no env is propagated', () => {
    const plist = renderUsagePollPlist({ nodeBin: '/n', cliJs: '/c', homeDir: '/h', startIntervalSecs: 300 });
    expect(plist).not.toContain('EnvironmentVariables');
  });

  test('bakes propagated env into EnvironmentVariables with XML escaping', () => {
    const plist = renderUsagePollPlist({
      nodeBin: '/n', cliJs: '/c', homeDir: '/h', startIntervalSecs: 300,
      env: { HEDDLE_USAGE_DIR: '/custom&dir', HEDDLE_ACCOUNTS: '/acc.json' },
    });
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>HEDDLE_USAGE_DIR</key>\n    <string>/custom&amp;dir</string>');
    expect(plist).toContain('<key>HEDDLE_ACCOUNTS</key>\n    <string>/acc.json</string>');
    expect(plist).not.toContain('/custom&dir');
  });
});

describe('installUsagePollLaunchd', () => {
  test('refuses when the window keeper is loaded without writing, booting out, or bootstrapping', () => {
    const calls: string[] = [];
    const report = installUsagePollLaunchd({}, {
      homeDir: home(),
      uid: 501,
      isKeeperLoaded: () => true,
      writePlist: () => { calls.push('write'); },
      bootout: () => { calls.push('bootout'); },
      bootstrap: () => { calls.push('bootstrap'); },
    });

    expect(report).toMatchObject({ action: 'refused', keeperConflict: true, loaded: false });
    expect(calls).toEqual([]);
  });

  test('aborts (throws) when keeper status cannot be determined — fail-safe against a second producer', () => {
    const calls: string[] = [];
    expect(() => installUsagePollLaunchd({}, {
      homeDir: home(),
      uid: 501,
      isKeeperLoaded: () => { throw new Error('launchctl unreadable'); },
      writePlist: () => { calls.push('write'); },
      bootstrap: () => { calls.push('bootstrap'); },
    })).toThrow(/unreadable/);
    expect(calls).toEqual([]);
  });

  test('refuses to bake a worktree-relative cli.js into a persistent LaunchAgent', () => {
    const root = home();
    const calls: string[] = [];
    const report = installUsagePollLaunchd({}, {
      homeDir: root, uid: 501,
      nodeBin: '/resolved/node',
      cliJs: '/Users/x/.worktrees/T-doctor/dist/cli.js',
      isKeeperLoaded: () => false,
      writePlist: () => { calls.push('write'); },
      bootstrap: () => { calls.push('bootstrap'); },
    });
    expect(report).toMatchObject({ action: 'refused', keeperConflict: false, loaded: false });
    expect(report.message).toMatch(/worktree/);
    expect(calls).toEqual([]);
    expect(existsSync(plistIn(root))).toBe(false);
  });

  test('plans creation during a dry run without writing or bootstrapping', () => {
    const root = home();
    const calls: string[] = [];
    const report = installUsagePollLaunchd({ dryRun: true }, {
      homeDir: root, uid: 501,
      nodeBin: '/resolved/node',
      cliJs: '/resolved/cli.js',
      env: {},
      isKeeperLoaded: () => false,
      writePlist: () => { calls.push('write'); },
      bootout: () => { calls.push('bootout'); },
      bootstrap: () => { calls.push('bootstrap'); },
    });

    expect(report).toMatchObject({ action: 'would-create', loaded: false, dryRun: true });
    expect(existsSync(plistIn(root))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('dry run reports would-skip when the installed plist already matches', () => {
    const root = home();
    installUsagePollLaunchd({}, noKeeper(root));
    const report = installUsagePollLaunchd({ dryRun: true }, noKeeper(root));
    expect(report.action).toBe('would-skip');
  });

  test('dry run reports would-update when the installed plist differs, leaving it unchanged', () => {
    const root = home();
    installUsagePollLaunchd({}, noKeeper(root));
    const before = readFileSync(plistIn(root), 'utf8');
    const report = installUsagePollLaunchd({ startIntervalSecs: 600, dryRun: true }, noKeeper(root));
    expect(report.action).toBe('would-update');
    expect(readFileSync(plistIn(root), 'utf8')).toBe(before);
  });

  test('creates the plist and reloads launchd with its uid and path', () => {
    const root = home();
    const bootoutCalls: Array<[number, string]> = [];
    const bootstrapCalls: Array<[number, string]> = [];
    const report = installUsagePollLaunchd({}, noKeeper(root, {
      bootout: (uid: number, path: string) => { bootoutCalls.push([uid, path]); },
      bootstrap: (uid: number, path: string) => { bootstrapCalls.push([uid, path]); },
    }));

    const plistPath = plistIn(root);
    expect(report).toMatchObject({ action: 'created', loaded: true, plistPath });
    expect(readFileSync(plistPath, 'utf8')).toContain('<string>/resolved/node</string>\n    <string>/resolved/cli.js</string>');
    expect(bootoutCalls).toEqual([[501, plistPath]]);
    expect(bootstrapCalls).toEqual([[501, plistPath]]);
  });

  test('reboots the job when its plist is unchanged', () => {
    const root = home();
    const bootstrapCalls: Array<[number, string]> = [];
    const deps = noKeeper(root, { bootstrap: (uid: number, path: string) => { bootstrapCalls.push([uid, path]); } });

    installUsagePollLaunchd({}, deps);
    const report = installUsagePollLaunchd({}, deps);

    expect(report.action).toBe('unchanged');
    expect(bootstrapCalls).toHaveLength(2);
  });

  test('bakes only the propagated env overrides that are set at install time', () => {
    const root = home();
    installUsagePollLaunchd({}, noKeeper(root, {
      env: { HEDDLE_USAGE_DIR: '/custom/usage', HEDDLE_ACCOUNTS: '/custom/accounts.json', PATH: '/bin', HOME: '/nope' },
    }));
    const plist = readFileSync(plistIn(root), 'utf8');
    expect(plist).toContain('<key>HEDDLE_USAGE_DIR</key>\n    <string>/custom/usage</string>');
    expect(plist).toContain('<key>HEDDLE_ACCOUNTS</key>\n    <string>/custom/accounts.json</string>');
    expect(plist).not.toContain('/bin');
    expect(plist).not.toContain('<key>HOME</key>');
  });

  test('uses explicit command paths and poll interval', () => {
    const root = home();
    const report = installUsagePollLaunchd({ startIntervalSecs: 600 }, noKeeper(root, { env: {} }));

    const plist = readFileSync(report.plistPath, 'utf8');
    expect(plist).toContain('<string>/resolved/node</string>\n    <string>/resolved/cli.js</string>');
    expect(plist).toContain('<integer>600</integer>');
  });
});
