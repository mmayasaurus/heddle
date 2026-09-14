import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE_POLL_LABEL = 'io.heddle.usage-poll-claude';
export const WINDOW_KEEPER_LABEL = 'io.heddle.window-keeper';
export const DEFAULT_POLL_INTERVAL_SECS = 300;

// Overrides the scheduled `heddle usage poll-claude` reads that a minimal launchd environment would
// otherwise drop — so the producer polls the same registry and writes the same sidecar directory the
// installing shell (and the rest of heddle) uses. Baked into the plist's EnvironmentVariables only
// when set at install time; unset ⇒ omitted ⇒ the job uses the same defaults every other command does.
const PROPAGATED_ENV_KEYS = ['HEDDLE_USAGE_DIR', 'HEDDLE_ACCOUNTS'] as const;

// launchctl print exits 113 ("Could not find …") for an absent service — the ONLY failure that proves
// the keeper is not loaded. Any other failure (spawn ENOENT, EPERM, transient) is indeterminate.
const LAUNCHCTL_NOT_FOUND_STATUS = 113;

export interface UsagePollLaunchdDeps {
  homeDir?: string;
  uid?: number;
  nodeBin?: string;
  cliJs?: string;
  env?: NodeJS.ProcessEnv;
  isKeeperLoaded?: (uid: number) => boolean;
  readPlist?: (path: string) => string | null;
  writePlist?: (path: string, contents: string) => void;
  bootout?: (uid: number, plistPath: string) => void;
  bootstrap?: (uid: number, plistPath: string) => void;
}

export interface UsagePollLaunchdOptions {
  dryRun?: boolean;
  startIntervalSecs?: number;
}

export interface UsagePollLaunchdReport {
  label: string;
  plistPath: string;
  action: 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update' | 'would-skip' | 'refused';
  nodeBin: string;
  cliJs: string;
  startIntervalSecs: number;
  env: Record<string, string>;
  keeperConflict: boolean;
  loaded: boolean;
  dryRun: boolean;
  message: string;
}

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export function renderUsagePollPlist(opts: {
  nodeBin: string;
  cliJs: string;
  homeDir: string;
  startIntervalSecs: number;
  env?: Record<string, string>;
}): string {
  const nodeBin = escapeXml(opts.nodeBin);
  const cliJs = escapeXml(opts.cliJs);
  const homeDir = escapeXml(opts.homeDir);
  const envEntries = Object.entries(opts.env ?? {});
  const envBlock = envEntries.length === 0 ? '' : `  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`).join('\n')}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${USAGE_POLL_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliJs}</string>
    <string>usage</string>
    <string>poll-claude</string>
  </array>
${envBlock}  <key>StartInterval</key>
  <integer>${opts.startIntervalSecs}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homeDir}/.heddle/usage-poll-claude.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${homeDir}/.heddle/usage-poll-claude.launchd.err</string>
</dict>
</plist>
`;
}

const defaultIsKeeperLoaded = (uid: number): boolean => {
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${WINDOW_KEEPER_LABEL}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer | string };
    const stderr = String(err.stderr ?? '').trim();
    // Only a confirmed "not found" proves the keeper is absent. Every other failure is indeterminate:
    // fail SAFE by refusing rather than installing a second producer past an unreadable keeper status.
    if (err.status === LAUNCHCTL_NOT_FOUND_STATUS || /could not find|no such/i.test(stderr)) return false;
    throw new Error(
      `cannot determine whether ${WINDOW_KEEPER_LABEL} is loaded (launchctl exit ${err.status ?? err.code ?? '?'}` +
      `${stderr ? `: ${stderr}` : ''}); refusing to install a second usage producer.`,
    );
  }
};

const defaultReadPlist = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const defaultWritePlist = (path: string, contents: string): void => {
  const launchAgentsDir = dirname(path);
  const homeDir = dirname(dirname(launchAgentsDir));
  mkdirSync(join(homeDir, '.heddle'), { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  const temp = join(launchAgentsDir, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temp, contents);
    chmodSync(temp, 0o644);
    renameSync(temp, path);
  } finally {
    // Best-effort cleanup: a rename success leaves no temp, and a cleanup error must never mask the
    // real write error propagating out of the try.
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch { /* leave the stray temp rather than shadow the original failure */ }
  }
};

const defaultBootout = (uid: number, plistPath: string): void => {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  } catch {
    // A job that was not already loaded has nothing to boot out — expected on a first install.
  }
};

const defaultBootstrap = (uid: number, plistPath: string): void => {
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = String(err.stderr ?? '').trim();
    throw new Error(`launchctl bootstrap gui/${uid} ${plistPath} failed${stderr ? `: ${stderr}` : ` (${err.message})`}`);
  }
};

// The producer plist runs `node <cli.js>`; resolve THIS process's sibling dist/cli.js so the running
// heddle self-resolves its own entrypoint (no fnm-alias guessing, no env-node shebang trap). realpath
// resolves a symlinked entry, but a missing target must NOT throw: the refuse/dry-run paths write
// nothing and need no valid CLI, and an absent CLI at run time surfaces in the launchd .err log (never
// bad data) rather than blocking the install. Fall back to the raw path string when realpath can't stat it.
const defaultCliJs = (): string => {
  const raw = fileURLToPath(new URL('cli.js', import.meta.url));
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
};

// A LaunchAgent outlives the shell that installed it. A cli.js under a git worktree
// (…/.worktrees/<name>/dist/cli.js) is removed when the worktree is, silently breaking every future
// poll — so refuse to bake one, mirroring the dashboard keeper installer.
const isWorktreePath = (path: string): boolean => path.split(sep).includes('.worktrees');

export function installUsagePollLaunchd(options: UsagePollLaunchdOptions = {}, partial: UsagePollLaunchdDeps = {}): UsagePollLaunchdReport {
  const homeDir = partial.homeDir ?? homedir();
  const uid = partial.uid ?? process.getuid?.() ?? 0;
  const nodeBin = partial.nodeBin ?? process.execPath;
  const cliJs = partial.cliJs ?? defaultCliJs();
  const startIntervalSecs = options.startIntervalSecs ?? DEFAULT_POLL_INTERVAL_SECS;
  if (!Number.isInteger(startIntervalSecs) || startIntervalSecs <= 0) throw new Error('startIntervalSecs must be a positive integer');

  const sourceEnv = partial.env ?? process.env;
  const env: Record<string, string> = {};
  for (const key of PROPAGATED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined && value !== '') env[key] = value;
  }

  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${USAGE_POLL_LABEL}.plist`);
  const dryRun = options.dryRun === true;
  const base = { label: USAGE_POLL_LABEL, plistPath, nodeBin, cliJs, startIntervalSecs, env };

  // The either/or keeper guard (guardrail): exactly one usage-sidecar producer per machine.
  if ((partial.isKeeperLoaded ?? defaultIsKeeperLoaded)(uid)) {
    return {
      ...base, action: 'refused', keeperConflict: true, loaded: false, dryRun,
      message: `${WINDOW_KEEPER_LABEL} is loaded and already produces usage sidecars; exactly one producer is allowed per machine.`,
    };
  }

  // Never bake an ephemeral (worktree) CLI path into a persistent LaunchAgent.
  if (isWorktreePath(cliJs)) {
    return {
      ...base, action: 'refused', keeperConflict: false, loaded: false, dryRun,
      message: `resolved CLI path is inside a git worktree (${cliJs}); refusing to bake an ephemeral path into a persistent LaunchAgent — run from an installed heddle or pass an explicit cli.js.`,
    };
  }

  const rendered = renderUsagePollPlist({ nodeBin, cliJs, homeDir, startIntervalSecs, env });
  const existing = (partial.readPlist ?? defaultReadPlist)(plistPath);
  const action = existing === null ? 'created' : existing === rendered ? 'unchanged' : 'updated';
  if (dryRun) {
    const plannedAction = action === 'created' ? 'would-create' : action === 'updated' ? 'would-update' : 'would-skip';
    return {
      ...base, action: plannedAction, keeperConflict: false, loaded: false, dryRun: true,
      message: `would ${plannedAction.slice('would-'.length)} ${plistPath}`,
    };
  }

  (partial.writePlist ?? defaultWritePlist)(plistPath, rendered);
  (partial.bootout ?? defaultBootout)(uid, plistPath);
  (partial.bootstrap ?? defaultBootstrap)(uid, plistPath);
  return {
    ...base, action, keeperConflict: false, loaded: true, dryRun: false,
    message: `${action} ${plistPath} and loaded ${USAGE_POLL_LABEL}`,
  };
}
