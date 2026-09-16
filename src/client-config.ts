import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseAddress } from './comms/address.js';
import { canonicalizePath, type InstallPlan, type InstallStep } from './init-project.js';

export const FLEET_CLIENTS = ['codex', 'cursor', 'gemini', 'opencode'] as const;
export type FleetClient = typeof FLEET_CLIENTS[number];
const here = dirname(fileURLToPath(import.meta.url));
const START = '# heddle fleet MCP: begin';
const END = '# heddle fleet MCP: end';
const GUIDE_START = '<!-- heddle fleet: begin -->';
const GUIDE_END = '<!-- heddle fleet: end -->';
const FORWARDED_ENV = ['HEDDLE_AGENT', 'FLEET_AGENT', 'HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT', 'HEDDLE_COMMS_ADDRESS', 'HEDDLE_COMMS_DB', 'HEDDLE_LEDGER_DB', 'HEDDLE_PROJECTS'];

export function parseFleetClients(value: string): FleetClient[] {
  const clients = value.split(',').map((s) => s.trim());
  if (!clients.length || clients.some((c) => !FLEET_CLIENTS.includes(c as FleetClient))) {
    throw new Error(`--clients requires a comma-separated list of: ${FLEET_CLIENTS.join(', ')}`);
  }
  return [...new Set(clients)] as FleetClient[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function checkedToml(raw: string) {
  try { return parseToml(raw); }
  catch { throw new Error('invalid Codex TOML configuration; repair the config before installing (contents omitted)'); }
}

export function clientFileSource(path: string): string | null {
  // Do not follow a config symlink or a symlinked parent into another checkout/user config.
  for (let part = path; ; part = dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(`refusing symlinked client configuration: ${part}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(part) === part) break;
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Check likely permission failures before a composed install changes any Claude files. */
export function checkClientParentWritable(path: string): void {
  let parent = dirname(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  accessSync(parent, constants.W_OK | constants.X_OK);
}

function managedBlock(raw: string, start: string, end: string): { before: string; after: string } {
  const starts: number[] = [], ends: Array<{ start: number; after: number }> = [];
  let offset = 0;
  for (const line of raw.split('\n')) {
    const marker = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (marker === start) starts.push(offset);
    if (marker === end) ends.push({ start: offset, after: Math.min(raw.length, offset + line.length + 1) });
    offset += line.length + 1;
  }
  if (!starts.length && !ends.length) return { before: raw + (raw && !raw.endsWith('\n') ? '\n' : ''), after: '' };
  if (starts.length !== 1 || ends.length !== 1 || ends[0].start < starts[0]) {
    throw new Error('malformed or duplicated heddle managed block; repair its markers before installing');
  }
  return { before: raw.slice(0, starts[0]), after: raw.slice(ends[0].after) };
}

function plannedFile(path: string, step: string, raw: string | null, content: string, dryRun: boolean): InstallStep[] {
  if (raw === content) return [{ path, step, content, expectedContent: raw, action: 'ok' }];
  const planned: InstallStep[] = [];
  if (raw !== null) {
    // Keep an immutable backup of each pre-edit version, including operator comments/formatting.
    let backup = `${path}.heddle-backup`;
    for (let n = 1; ; n++) {
      const prior = clientFileSource(backup);
      if (prior === raw) break;
      if (prior === null) {
        planned.push({ path: backup, step: `${step}:backup`, content: raw, expectedContent: null, action: dryRun ? 'would-create' : 'create', mode: 0o600, exclusive: true });
        break;
      }
      backup = `${path}.heddle-backup.${n}`;
    }
  }
  planned.push({ path, step, content, expectedContent: raw, action: raw === null ? (dryRun ? 'would-create' : 'create') : (dryRun ? 'would-update' : 'update') });
  return planned;
}

function serverDefinitions(dir: string, client: FleetClient, agent?: string) {
  return Object.fromEntries(['heddle', 'heddle-comms'].map((name) => [name, {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'client-mcp.js'), name, dir],
    env: { HEDDLE_CLIENT: client, ...(agent ? { HEDDLE_AGENT: agent, FLEET_AGENT: agent } : {}) },
    ...(client === 'gemini' ? { timeout: 660_000 } : {}),
  }]));
}

function tomlConfig(raw: string, servers: ReturnType<typeof serverDefinitions>): string {
  checkedToml(raw); // Never hide an existing syntax error or echo credential-bearing source text.
  const parts = managedBlock(raw, START, END);
  const remaining = parts.before + parts.after;
  const parsed = checkedToml(remaining);
  const existing = parsed.mcp_servers === undefined ? {} : object(parsed.mcp_servers, 'mcp_servers');
  for (const name of Object.keys(servers)) {
    if (Object.hasOwn(existing, name)) throw new Error(`Codex MCP server ${name} already exists outside the heddle managed block; preserve or relocate that entry before installing`);
  }
  const definitions = Object.fromEntries(Object.entries(servers).map(([name, def]) => [name, { ...def, env_vars: FORWARDED_ENV, tool_timeout_sec: 660 }]));
  const content = parts.before + `${START}\n${stringifyToml({ mcp_servers: definitions })}\n${END}\n` + parts.after;
  checkedToml(content); // Includes collisions with dotted/inline tables in the original config.
  return content;
}

function jsonConfig(raw: string | null, client: FleetClient, servers: ReturnType<typeof serverDefinitions>, path: string): string {
  let parsed: unknown;
  try { parsed = raw === null ? {} : JSON.parse(raw); }
  catch { throw new Error(`client configuration is not valid JSON: ${path}`); }
  const config = object(parsed, path);
  const key = client === 'opencode' ? 'mcp' : 'mcpServers';
  const existing = config[key] === undefined ? {} : object(config[key], `${path}: ${key}`);
  const next = { ...existing };
  for (const [name, def] of Object.entries(servers)) {
    const expected = client === 'opencode'
      ? { type: 'local', command: [def.command, ...def.args], environment: def.env, enabled: true, timeout: 660_000 }
      : def;
    if (Object.hasOwn(existing, name) && !isDeepStrictEqual(existing[name], expected)) {
      throw new Error(`MCP server ${name} already has different configuration in ${path}; existing settings were preserved`);
    }
    next[name] = expected;
  }
  if (raw !== null && isDeepStrictEqual(existing, next)) return raw;
  return JSON.stringify({ ...config, [key]: next }, null, 2) + '\n';
}

export interface ClientInstallOptions { dir: string; clients: FleetClient[]; agent?: string; dryRun?: boolean; homeDir?: string; }

/** An additive install: no Claude settings, hooks, launchers, accounts, or worker routes are edited. */
export function clientInstallSteps(options: ClientInstallOptions): InstallStep[] {
  const { dir, clients, agent } = options;
  if (!clients.length || clients.some((client) => !FLEET_CLIENTS.includes(client))) throw new Error('select at least one supported fleet client');
  if (agent !== undefined && parseAddress(agent)?.kind !== 'agent') throw new Error('--agent must be a fleet agent identity, not an operator, child, or room');
  const dryRun = options.dryRun === true;
  const steps: InstallStep[] = [];
  for (const client of new Set(clients)) {
    const relative = { codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', opencode: 'opencode.json' }[client];
    const path = join(dir, relative);
    // OpenCode loads JSONC too. Do not shadow it with a second competing project config.
    if (client === 'opencode' && existsSync(join(dir, 'opencode.jsonc'))) throw new Error('opencode.jsonc already exists; configure its mcp entries manually rather than creating a competing opencode.json');
    const raw = clientFileSource(path);
    const servers = serverDefinitions(dir, client, agent);
    const content = client === 'codex' ? tomlConfig(raw ?? '', servers) : jsonConfig(raw, client, servers, path);
    steps.push(...plannedFile(path, `client:${client}`, raw, content, dryRun));
  }
  const guidance = readFileSync(join(here, '..', 'assets', 'client-startup.md'), 'utf8');
  const instructionFiles = new Set(clients.map((client) => client === 'gemini' ? 'GEMINI.md' : 'AGENTS.md'));
  for (const file of instructionFiles) {
    const path = join(dir, file), raw = clientFileSource(path);
    const parts = managedBlock(raw ?? '', GUIDE_START, GUIDE_END);
    steps.push(...plannedFile(path, `client-instructions:${file}`, raw, parts.before + `${GUIDE_START}\n${guidance.trimEnd()}\n${GUIDE_END}\n` + parts.after, dryRun));
  }
  return steps;
}

/** Reuses the project's CAS/atomic install engine; init-project may compose the same steps. */
export function planClientInstall(input: ClientInstallOptions): InstallPlan {
  const target = resolve(input.dir);
  if (!existsSync(target)) throw new Error(`client target is not a directory: ${target}`);
  const dir = realpathSync.native(target);
  if (!lstatSync(dir).isDirectory()) throw new Error(`client target is not a directory: ${target}`);
  if (dir === dirname(dir) || dir === canonicalizePath(input.homeDir ?? homedir())) throw new Error('choose a project worktree, not the filesystem root or home directory');
  const steps = clientInstallSteps({ ...input, dir });
  return { options: { dir, canonical: dir, name: basename(dir), homeDir: input.homeDir ?? homedir(), dryRun: input.dryRun }, steps };
}
