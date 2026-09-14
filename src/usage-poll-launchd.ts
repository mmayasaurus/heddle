import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE_POLL_LABEL = 'io.heddle.usage-poll-claude';
export const WINDOW_KEEPER_LABEL = 'io.heddle.window-keeper';
export const DEFAULT_POLL_INTERVAL_SECS = 300;

export interface UsagePollLaunchdDeps {
  homeDir?: string;
  uid?: number;
  nodeBin?: string;
  cliJs?: string;
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

export function renderUsagePollPlist(opts: { nodeBin: string; cliJs: string; homeDir: string; startIntervalSecs: number }): string {
  const nodeBin = escapeXml(opts.nodeBin);
  const cliJs = escapeXml(opts.cliJs);
  const homeDir = escapeXml(opts.homeDir);
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
  <key>StartInterval</key>
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
    execFileSync('launchctl', ['print', `gui/${uid}/${WINDOW_KEEPER_LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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
    if (existsSync(temp)) unlinkSync(temp);
  }
};

const defaultBootout = (uid: number, plistPath: string): void => {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  } catch {
    // A job that was not already loaded has nothing to boot out.
  }
};

const defaultBootstrap = (uid: number, plistPath: string): void => {
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
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

export function installUsagePollLaunchd(options: UsagePollLaunchdOptions = {}, partial: UsagePollLaunchdDeps = {}): UsagePollLaunchdReport {
  const homeDir = partial.homeDir ?? homedir();
  const uid = partial.uid ?? process.getuid?.() ?? 0;
  const nodeBin = partial.nodeBin ?? process.execPath;
  const cliJs = partial.cliJs ?? defaultCliJs();
  const startIntervalSecs = options.startIntervalSecs ?? DEFAULT_POLL_INTERVAL_SECS;
  if (!Number.isInteger(startIntervalSecs) || startIntervalSecs <= 0) throw new Error('startIntervalSecs must be a positive integer');

  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${USAGE_POLL_LABEL}.plist`);
  const dryRun = options.dryRun === true;
  if ((partial.isKeeperLoaded ?? defaultIsKeeperLoaded)(uid)) {
    return {
      label: USAGE_POLL_LABEL, plistPath, action: 'refused', nodeBin, cliJs, startIntervalSecs,
      keeperConflict: true, loaded: false, dryRun,
      message: `${WINDOW_KEEPER_LABEL} is loaded and already produces usage sidecars; exactly one producer is allowed per machine.`,
    };
  }

  const rendered = renderUsagePollPlist({ nodeBin, cliJs, homeDir, startIntervalSecs });
  const existing = (partial.readPlist ?? defaultReadPlist)(plistPath);
  const action = existing === null ? 'created' : existing === rendered ? 'unchanged' : 'updated';
  if (dryRun) {
    const plannedAction = action === 'created' ? 'would-create' : action === 'updated' ? 'would-update' : 'would-skip';
    return {
      label: USAGE_POLL_LABEL, plistPath, action: plannedAction, nodeBin, cliJs, startIntervalSecs,
      keeperConflict: false, loaded: false, dryRun: true,
      message: `would ${plannedAction.slice('would-'.length)} ${plistPath}`,
    };
  }

  (partial.writePlist ?? defaultWritePlist)(plistPath, rendered);
  (partial.bootout ?? defaultBootout)(uid, plistPath);
  (partial.bootstrap ?? defaultBootstrap)(uid, plistPath);
  return {
    label: USAGE_POLL_LABEL, plistPath, action, nodeBin, cliJs, startIntervalSecs,
    keeperConflict: false, loaded: true, dryRun: false,
    message: `${action} ${plistPath} and loaded ${USAGE_POLL_LABEL}`,
  };
}
