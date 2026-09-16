import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useTempResources } from './helpers.js';
import { installUsagePollSystemd, renderUsagePollSystemd, USAGE_POLL_SERVICE, USAGE_POLL_TIMER } from '../src/usage-poll-systemd.js';
import { WINDOW_KEEPER_LABEL } from '../src/usage-poll-launchd.js';

const absent = 'LoadState=not-found\nFragmentPath=\nDropInPaths=\n';
const { tempDir } = useTempResources('heddle-systemd-test-');
function fixture() {
  const homeDir = tempDir();
  const cliJs = join(homeDir, 'cli.js');
  writeFileSync(cliJs, 'process.exit(0);\n');
  const systemctl = vi.fn((args: string[]): string => args[0] === 'show' ? absent : args[0] === 'is-active' ? 'active\n' : '');
  return { homeDir, cliJs, nodeBin: process.execPath, platform: 'linux' as const, env: {}, systemctl };
}

describe('Linux usage poll installer', () => {
  test('renders a shell-free poller with literal paths and only the intended environment', () => {
    const units = renderUsagePollSystemd({ nodeBin: '/opt/a b/node', cliJs: '/opt/$HOME/%i/"quoted"/cli.js',
      homeDir: '/home/test', startIntervalSecs: 420, env: {
        HEDDLE_ACCOUNTS: '/data/accounts with spaces.json', HEDDLE_USAGE_DIR: '/data/%u/$HOME/usage',
        ANTHROPIC_API_KEY: 'not-to-be-copied', HEDDLE_COMMS_OPERATOR_TOKEN: 'also-not-copied',
      } });
    expect(units.service).toContain('ExecStart=:"/opt/a b/node" "/opt/$HOME/%%i/\\"quoted\\"/cli.js" usage poll-claude');
    expect(units.service).toContain('Environment="HEDDLE_USAGE_DIR=/data/%%u/$HOME/usage"');
    expect(units.service).not.toMatch(/ANTHROPIC|OPERATOR_TOKEN|not-to-be-copied/);
    expect(units.service).toContain('Type=oneshot');
    expect(units.service).not.toContain('RemainAfterExit');
    expect(units.timer).toContain('OnActiveSec=1s');
    expect(units.timer).toContain('OnUnitInactiveSec=420s');
    expect(units.timer).toContain(`Unit=${USAGE_POLL_SERVICE}`);
  });

  test('preview works on macOS without writing or contacting the manager, honoring XDG_CONFIG_HOME', () => {
    const deps = fixture();
    const config = join(deps.homeDir, 'custom-config');
    const report = installUsagePollSystemd({ dryRun: true }, { ...deps, platform: 'darwin', env: { XDG_CONFIG_HOME: config } });
    expect(report).toMatchObject({ dryRun: true, activated: false });
    expect(report.files.map(f => f.path)).toEqual([USAGE_POLL_SERVICE, USAGE_POLL_TIMER].map(name => join(config, 'systemd/user', name)));
    expect(report.files[0].contents).toContain(`Environment="HEDDLE_ACCOUNTS=${deps.homeDir}/.heddle/accounts.json"`);
    expect(existsSync(config)).toBe(false);
    expect(deps.systemctl).not.toHaveBeenCalled();
  });

  test('refuses an actual install on another OS', () => {
    const deps = fixture();
    expect(() => installUsagePollSystemd({}, { ...deps, platform: 'darwin' })).toThrow(/requires Linux/);
    expect(deps.systemctl).not.toHaveBeenCalled();
    expect(existsSync(join(deps.homeDir, '.config'))).toBe(false);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid interval %s before any side effect', (interval) => {
    const deps = fixture();
    expect(() => installUsagePollSystemd({ startIntervalSecs: interval }, deps)).toThrow(/positive safe integer/);
    expect(deps.systemctl).not.toHaveBeenCalled();
  });

  test('rejects newline injection and relative registry paths even in preview', () => {
    const deps = fixture();
    expect(() => installUsagePollSystemd({ dryRun: true }, { ...deps, env: { HEDDLE_USAGE_DIR: '/data\nExecStart=bad' } })).toThrow(/control/);
    expect(() => installUsagePollSystemd({ dryRun: true }, { ...deps, env: { HEDDLE_ACCOUNTS: 'accounts.json' } })).toThrow(/absolute/);
    expect(() => installUsagePollSystemd({ dryRun: true }, { ...deps, env: { XDG_CONFIG_HOME: 'relative' } })).toThrow(/absolute/);
  });

  test('installs both units before activating; repeat installation is idempotent', () => {
    const deps = fixture();
    const report = installUsagePollSystemd({}, deps);
    expect(report.activated).toBe(true);
    for (const file of report.files) {
      expect(readFileSync(file.path, 'utf8')).toBe(file.contents);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
    }
    expect(deps.systemctl.mock.calls.map(([args]) => args).slice(-4)).toEqual([
      ['daemon-reload'], ['enable', USAGE_POLL_TIMER], ['restart', USAGE_POLL_TIMER], ['is-active', USAGE_POLL_TIMER],
    ]);
    deps.systemctl.mockImplementation(args => {
      if (args[0] !== 'show') return args[0] === 'is-active' ? 'active\n' : '';
      const file = report.files.find(f => f.path.endsWith(`/${args[1]}`));
      return file ? `LoadState=loaded\nFragmentPath=${file.path}\nDropInPaths=\n` : absent;
    });
    const again = installUsagePollSystemd({}, deps);
    expect(again.files.map(f => f.action)).toEqual(['unchanged', 'unchanged']);
    expect(again.files.every(f => f.backupPath === undefined)).toBe(true);
  });

  test('preserves the previous managed timer when changing the interval', () => {
    const deps = fixture();
    const before = installUsagePollSystemd({}, deps);
    const after = installUsagePollSystemd({ startIntervalSecs: 600 }, deps);
    expect(after.files[0].action).toBe('unchanged');
    expect(after.files[1].action).toBe('update');
    expect(readFileSync(after.files[1].backupPath!, 'utf8')).toBe(before.files[1].contents);
    expect(readFileSync(after.files[1].path, 'utf8')).toContain('OnUnitInactiveSec=600s');
  });

  test.each(['service', 'timer'])('refuses a configured window-keeper %s without writing or activating', (kind) => {
    const deps = fixture();
    deps.systemctl.mockImplementation(args => args[1] === `${WINDOW_KEEPER_LABEL}.${kind}` ? 'LoadState=loaded\n' : absent);
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/second usage scheduler/);
    expect(existsSync(join(deps.homeDir, '.config'))).toBe(false);
    expect(deps.systemctl.mock.calls.every(([args]) => args[0] === 'show')).toBe(true);
  });

  test('manager/bus errors and ambiguous states never become permission to install', () => {
    const deps = fixture();
    deps.systemctl.mockImplementation(() => { throw new Error('user bus unavailable'); });
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/user bus unavailable/);
    deps.systemctl.mockReturnValue('');
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/LoadState=unknown/);
    expect(existsSync(join(deps.homeDir, '.config'))).toBe(false);
  });

  test('does not overwrite unrelated units or symlinked unit files', () => {
    const deps = fixture();
    const dir = join(deps.homeDir, '.config/systemd/user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, USAGE_POLL_TIMER), '# user-owned timer\n');
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/unmanaged/);
    expect(existsSync(join(dir, USAGE_POLL_SERVICE))).toBe(false);
    const another = fixture();
    const otherDir = join(another.homeDir, '.config/systemd/user');
    mkdirSync(otherDir, { recursive: true });
    symlinkSync(another.cliJs, join(otherDir, USAGE_POLL_SERVICE));
    expect(() => installUsagePollSystemd({}, another)).toThrow(/non-regular/);
    expect(readFileSync(another.cliJs, 'utf8')).toBe('process.exit(0);\n');
  });

  test.each([
    'LoadState=loaded\nFragmentPath=/elsewhere/poll.service\nDropInPaths=\n',
    'LoadState=loaded\nFragmentPath=/elsewhere/poll.service\nDropInPaths=/extra.conf\n',
    'LoadState=masked\n',
  ])('refuses effective unit overrides: %s', (state) => {
    const deps = fixture();
    deps.systemctl.mockImplementation(args => args[1] === USAGE_POLL_SERVICE ? state : absent);
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/refusing|cannot safely install/);
    expect(existsSync(join(deps.homeDir, '.config'))).toBe(false);
  });

  test('rejects worktree executables even through a symlink', () => {
    const deps = fixture();
    const ephemeral = join(deps.homeDir, '.worktrees/D');
    mkdirSync(ephemeral, { recursive: true });
    writeFileSync(join(ephemeral, 'cli.js'), '');
    const link = join(deps.homeDir, 'stable-looking.js');
    symlinkSync(join(ephemeral, 'cli.js'), link);
    expect(() => installUsagePollSystemd({}, { ...deps, cliJs: link })).toThrow(/disposable/);
    expect(deps.systemctl).not.toHaveBeenCalled();
  });

  test.each(['daemon-reload', 'enable', 'restart', 'is-active'])('reports %s failure without claiming activation', (failure) => {
    const deps = fixture();
    deps.systemctl.mockImplementation(args => {
      if (args[0] === failure) throw new Error('synthetic manager failure');
      return args[0] === 'show' ? absent : '';
    });
    expect(() => installUsagePollSystemd({}, deps)).toThrow(/activation was not verified/);
    expect(existsSync(join(deps.homeDir, '.config/systemd/user', USAGE_POLL_SERVICE))).toBe(true);
    expect(deps.systemctl.mock.calls.at(-1)![0][0]).toBe(failure);
  });

  test('standalone command previews from an isolated home and rejects malformed arguments', () => {
    const home = tempDir();
    const args = ['dist/usage-poll-systemd-bin.js', '--dry-run', '--json'];
    const env = { PATH: process.env.PATH, HOME: home };
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', env });
    expect(JSON.parse(out)).toMatchObject({ activated: false, dryRun: true });
    expect(existsSync(join(home, '.config'))).toBe(false);
    for (const arg of ['0', '-2', '1.5', '5s', '']) {
      const bad = spawnSync(process.execPath, [...args, `--start-interval=${arg}`], { encoding: 'utf8', env });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/positive integer/);
    }
  });

  test('real subprocess boundary accepts explicit not-found but refuses a failed user bus', () => {
    const deps = fixture();
    const bin = join(deps.homeDir, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'systemctl');
    // Exercise execFileSync/status parsing without accessing the machine's service manager.
    writeFileSync(fake, '#!/bin/sh\ncase "$2" in\nshow) printf "LoadState=not-found\\n"; exit 1;;\nis-active) echo active;;\nesac\n', { mode: 0o755 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      expect(installUsagePollSystemd({}, { ...deps, systemctl: undefined }).activated).toBe(true);
      writeFileSync(fake, '#!/bin/sh\necho "Failed to connect to bus" >&2\nexit 1\n');
      const other = fixture();
      expect(() => installUsagePollSystemd({}, { ...other, systemctl: undefined })).toThrow(/systemctl.*failed/);
      expect(existsSync(join(other.homeDir, '.config'))).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  // Ubuntu CI checks generated files with the real parser; no user manager or service is started.
  test.skipIf(process.platform !== 'linux')('generated units pass systemd-analyze verify on Linux', () => {
    const deps = fixture();
    const { files } = installUsagePollSystemd({ dryRun: true }, deps);
    const unitDir = tempDir();
    const paths = files.map((file, i) => {
      const path = join(unitDir, i === 0 ? USAGE_POLL_SERVICE : USAGE_POLL_TIMER);
      writeFileSync(path, file.contents);
      return path;
    });
    execFileSync('systemd-analyze', ['verify', '--man=no', ...paths], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, HOME: deps.homeDir },
    });
  });
});
