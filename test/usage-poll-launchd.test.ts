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
});

describe('installUsagePollLaunchd', () => {
  test('refuses when the window keeper is loaded without writing or bootstrapping', () => {
    const writeCalls: string[] = [];
    const bootstrapCalls: Array<[number, string]> = [];
    const report = installUsagePollLaunchd({}, {
      homeDir: home(),
      uid: 501,
      isKeeperLoaded: () => true,
      writePlist: (path) => { writeCalls.push(path); },
      bootstrap: (uid, path) => { bootstrapCalls.push([uid, path]); },
    });

    expect(report).toMatchObject({ action: 'refused', keeperConflict: true, loaded: false });
    expect(writeCalls).toEqual([]);
    expect(bootstrapCalls).toEqual([]);
  });

  test('plans creation during a dry run without writing or bootstrapping', () => {
    const root = home();
    const bootstrapCalls: Array<[number, string]> = [];
    const report = installUsagePollLaunchd({ dryRun: true }, {
      homeDir: root,
      uid: 501,
      isKeeperLoaded: () => false,
      bootstrap: (uid, path) => { bootstrapCalls.push([uid, path]); },
    });

    expect(report).toMatchObject({ action: 'would-create', loaded: false, dryRun: true });
    expect(existsSync(join(root, 'Library', 'LaunchAgents', `${USAGE_POLL_LABEL}.plist`))).toBe(false);
    expect(bootstrapCalls).toEqual([]);
  });

  test('creates the plist and reloads launchd with its uid and path', () => {
    const root = home();
    const bootoutCalls: Array<[number, string]> = [];
    const bootstrapCalls: Array<[number, string]> = [];
    const report = installUsagePollLaunchd({}, {
      homeDir: root,
      uid: 501,
      nodeBin: '/resolved/node',
      cliJs: '/resolved/cli.js',
      isKeeperLoaded: () => false,
      bootout: (uid, path) => { bootoutCalls.push([uid, path]); },
      bootstrap: (uid, path) => { bootstrapCalls.push([uid, path]); },
    });

    const plistPath = join(root, 'Library', 'LaunchAgents', `${USAGE_POLL_LABEL}.plist`);
    expect(report).toMatchObject({ action: 'created', loaded: true, plistPath });
    expect(readFileSync(plistPath, 'utf8')).toContain('<string>/resolved/node</string>\n    <string>/resolved/cli.js</string>');
    expect(bootoutCalls).toEqual([[501, plistPath]]);
    expect(bootstrapCalls).toEqual([[501, plistPath]]);
  });

  test('reboots the job when its plist is unchanged', () => {
    const root = home();
    const bootstrapCalls: Array<[number, string]> = [];
    const deps = {
      homeDir: root,
      uid: 501,
      nodeBin: '/resolved/node',
      cliJs: '/resolved/cli.js',
      isKeeperLoaded: () => false,
      bootout: () => {},
      bootstrap: (uid: number, path: string) => { bootstrapCalls.push([uid, path]); },
    };

    installUsagePollLaunchd({}, deps);
    const report = installUsagePollLaunchd({}, deps);

    expect(report.action).toBe('unchanged');
    expect(bootstrapCalls).toHaveLength(2);
  });

  test('uses explicit command paths and poll interval', () => {
    const root = home();
    const report = installUsagePollLaunchd({ startIntervalSecs: 600 }, {
      homeDir: root,
      uid: 501,
      nodeBin: '/custom/node',
      cliJs: '/custom/cli.js',
      isKeeperLoaded: () => false,
      bootout: () => {},
      bootstrap: () => {},
    });

    const plist = readFileSync(report.plistPath, 'utf8');
    expect(plist).toContain('<string>/custom/node</string>\n    <string>/custom/cli.js</string>');
    expect(plist).toContain('<integer>600</integer>');
  });
});
