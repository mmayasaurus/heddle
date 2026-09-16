import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureWriteFile } from './secure-fs.js';
import { DEFAULT_POLL_INTERVAL_SECS, USAGE_POLL_LABEL, WINDOW_KEEPER_LABEL } from './usage-poll-launchd.js';

export const USAGE_POLL_SERVICE = `${USAGE_POLL_LABEL}.service`;
export const USAGE_POLL_TIMER = `${USAGE_POLL_LABEL}.timer`;
const MANAGED = '# Managed by heddle usage-poll-systemd v1\n';

export interface UsagePollSystemdOptions {
  dryRun?: boolean;
  startIntervalSecs?: number;
}

export interface UsagePollSystemdDeps {
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodeBin?: string;
  cliJs?: string;
  env?: NodeJS.ProcessEnv;
  systemctl?: (args: string[]) => string;
}

export interface SystemdFileAction {
  path: string;
  contents: string;
  action: 'create' | 'update' | 'unchanged';
  backupPath?: string;
}

export interface UsagePollSystemdReport {
  dryRun: boolean;
  activated: boolean;
  files: SystemdFileAction[];
  commands: string[][];
}

// systemd.syntax quoting, plus literal percent escaping for systemd.unit specifiers.
// ExecStart uses the ':' prefix to disable dollar expansion without invoking a shell.
function unitString(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('systemd paths must not contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  unitString(value);
  return resolve(value);
}

export function renderUsagePollSystemd(opts: {
  nodeBin: string; cliJs: string; homeDir: string; startIntervalSecs: number;
  env?: NodeJS.ProcessEnv;
}): { service: string; timer: string } {
  if (!Number.isSafeInteger(opts.startIntervalSecs) || opts.startIntervalSecs <= 0) {
    throw new Error('startIntervalSecs must be a positive safe integer');
  }
  const node = absolutePath(opts.nodeBin, 'Node executable');
  const cli = absolutePath(opts.cliJs, 'CLI entry point');
  const home = absolutePath(opts.homeDir, 'Home directory');
  // Pin both defaults as well as overrides: the user manager may retain a different shell's env.
  const env = {
    HOME: home,
    HEDDLE_ACCOUNTS: absolutePath(opts.env?.HEDDLE_ACCOUNTS || join(home, '.heddle', 'accounts.json'), 'HEDDLE_ACCOUNTS'),
    HEDDLE_USAGE_DIR: absolutePath(opts.env?.HEDDLE_USAGE_DIR || join(home, '.heddle', 'usage'), 'HEDDLE_USAGE_DIR'),
  };
  return {
    service: `${MANAGED}[Unit]
Description=Heddle Claude usage polling

[Service]
Type=oneshot
ExecStart=:${unitString(node)} ${unitString(cli)} usage poll-claude
${Object.entries(env).map(([key, value]) => `Environment=${unitString(`${key}=${value}`)}`).join('\n')}
StandardOutput=journal
StandardError=journal
`,
    timer: `${MANAGED}[Unit]
Description=Poll Heddle Claude usage periodically

[Timer]
OnActiveSec=1s
OnUnitInactiveSec=${opts.startIntervalSecs}s
AccuracySec=1s
Unit=${USAGE_POLL_SERVICE}

[Install]
WantedBy=timers.target
`,
  };
}

function systemctl(args: string[]): string {
  try {
    return execFileSync('systemctl', ['--user', ...args], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    // Only an explicit not-found LoadState proves absence; a missing binary/bus is not absence.
    if (args[0] === 'show' && err.status === 1 && /^LoadState=not-found$/m.test(err.stdout ?? '')) {
      return err.stdout!;
    }
    throw new Error(`systemctl --user ${args.join(' ')} failed (${err.code ?? err.status ?? 'unknown'}); check the user service manager and retry`, { cause: error });
  }
}

function unitState(run: (args: string[]) => string, unit: string): Record<string, string> {
  const output = run(['show', unit, '--property=LoadState,FragmentPath,DropInPaths']);
  const state = Object.fromEntries(output.trim().split('\n').map((line) => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  if (!['not-found', 'loaded'].includes(state.LoadState)) {
    throw new Error(`cannot safely install: ${unit} has LoadState=${state.LoadState ?? 'unknown'}`);
  }
  return state;
}

function planFile(path: string, contents: string): SystemdFileAction {
  let previous: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error(`refusing non-regular systemd unit: ${path}`);
    previous = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, contents, action: 'create' };
    throw error;
  }
  if (previous === contents) return { path, contents, action: 'unchanged' };
  if (!previous.startsWith(MANAGED)) throw new Error(`refusing to overwrite an unmanaged systemd unit: ${path}`);
  return { path, contents, action: 'update' };
}

/** Opt-in installer; dry-run is portable and never contacts systemd or writes files. */
export function installUsagePollSystemd(
  options: UsagePollSystemdOptions = {}, deps: UsagePollSystemdDeps = {},
): UsagePollSystemdReport {
  const dryRun = options.dryRun === true;
  if (!dryRun && (deps.platform ?? process.platform) !== 'linux') {
    throw new Error('systemd usage polling requires Linux; use --dry-run to preview on another OS');
  }
  const home = absolutePath(deps.homeDir ?? homedir(), 'Home directory');
  const env = deps.env ?? process.env;
  const configHome = absolutePath(env.XDG_CONFIG_HOME || join(home, '.config'), 'XDG_CONFIG_HOME');
  const node = absolutePath(deps.nodeBin ?? process.execPath, 'Node executable');
  const cli = absolutePath(deps.cliJs ?? fileURLToPath(new URL('cli.js', import.meta.url)), 'CLI entry point');
  const rendered = renderUsagePollSystemd({ nodeBin: node, cliJs: cli, homeDir: home,
    startIntervalSecs: options.startIntervalSecs ?? DEFAULT_POLL_INTERVAL_SECS, env });
  const unitDir = join(configHome, 'systemd', 'user');
  const files = [planFile(join(unitDir, USAGE_POLL_SERVICE), rendered.service),
    planFile(join(unitDir, USAGE_POLL_TIMER), rendered.timer)];
  const commands = [['daemon-reload'], ['enable', USAGE_POLL_TIMER], ['restart', USAGE_POLL_TIMER],
    ['is-active', USAGE_POLL_TIMER]];
  if (dryRun) return { dryRun, activated: false, files, commands };

  // Resolve symlinks before rejecting disposable worktrees, then bake the resolved runtime paths.
  const resolvedNode = realpathSync(node);
  const resolvedCli = realpathSync(cli);
  if ([resolvedNode, resolvedCli].some((path) => path.split(sep).includes('.worktrees'))) {
    throw new Error('refusing to schedule an executable inside a disposable .worktrees directory; use a stable installation');
  }
  accessSync(resolvedNode, constants.X_OK);
  accessSync(resolvedCli, constants.R_OK);
  if (!lstatSync(resolvedCli).isFile()) throw new Error('CLI entry point must be a regular file');
  const stable = renderUsagePollSystemd({ nodeBin: resolvedNode, cliJs: resolvedCli, homeDir: home,
    startIntervalSecs: options.startIntervalSecs ?? DEFAULT_POLL_INTERVAL_SECS, env });
  files[0] = planFile(files[0].path, stable.service);

  const run = deps.systemctl ?? systemctl;
  for (const kind of ['service', 'timer']) {
    const unit = `${WINDOW_KEEPER_LABEL}.${kind}`;
    if (unitState(run, unit).LoadState !== 'not-found') {
      throw new Error(`refusing a second usage scheduler: ${unit} exists; keep one usage producer`);
    }
  }
  for (const file of files) {
    const unit = file.path === files[0].path ? USAGE_POLL_SERVICE : USAGE_POLL_TIMER;
    const state = unitState(run, unit);
    if (state.LoadState === 'loaded' && (state.FragmentPath !== file.path || state.DropInPaths)) {
      throw new Error(`refusing to shadow a unit from another path or with drop-ins: ${unit}`);
    }
  }

  // Validate both files before writing either. Keep old managed contents for operator recovery.
  for (const file of files) {
    if (file.action === 'update') {
      file.backupPath = `${file.path}.backup-${randomUUID()}`;
      secureWriteFile(file.backupPath, readFileSync(file.path, 'utf8'));
    }
  }
  for (const file of files) if (file.action !== 'unchanged') secureWriteFile(file.path, file.contents);
  try {
    for (const command of commands) {
      const output = run(command);
      if (command[0] === 'is-active' && output.trim() !== 'active') throw new Error('timer did not become active');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`systemd units were written in ${unitDir}, but activation was not verified: ${reason}; inspect systemctl --user status ${USAGE_POLL_TIMER} before retrying`, { cause: error });
  }
  return { dryRun, activated: true, files, commands };
}
