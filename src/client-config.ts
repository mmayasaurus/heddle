import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isHeddleHookCommand } from './hook-command.js';
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
const IDENTITY_ENV = ['HEDDLE_AGENT', 'FLEET_AGENT', 'HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT', 'HEDDLE_COMMS_ADDRESS'];
const FORWARDED_ENV = [...IDENTITY_ENV, 'HEDDLE_COMMS_DB', 'HEDDLE_LEDGER_DB', 'HEDDLE_PROJECTS'];

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

function checkedJson(raw: string, path: string): Record<string, unknown> {
  try { return object(JSON.parse(raw), path); }
  catch { throw new Error(`invalid JSON configuration in ${path} (contents omitted)`); }
}

export function clientFileSource(path: string, maxBytes?: number): string | null {
  // Do not follow a config symlink or a symlinked parent into another checkout/user config.
  for (let part = path; ; part = dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(`refusing symlinked client configuration: ${part}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(part) === part) break;
  }
  if (!existsSync(path)) return null;
  if (maxBytes === undefined) return readFileSync(path, 'utf8');
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maxBytes) throw new Error('client marker is not a bounded regular file');
  // POSIX flags prevent following a replaced leaf or blocking on a FIFO. Compare descriptor
  // identity too, including on Windows where O_NONBLOCK/O_NOFOLLOW are zero.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('client marker changed while opening');
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('client marker is not a bounded regular file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0, count: number;
    while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, used)) > 0) used += count;
    if (used > maxBytes) throw new Error('client marker exceeds its read limit');
    return bytes.toString('utf8', 0, used);
  } finally { closeSync(fd); }
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

export function serverDefinitions(dir: string, client: FleetClient, agent?: string, workerEnv?: Record<string, string>) {
  // Some native clients sanitize the MCP subprocess environment. Preserve explicit broker/project
  // locations without copying ambient credentials into generated configuration.
  const paths = Object.fromEntries(['HEDDLE_COMMS_DB', 'HEDDLE_LEDGER_DB', 'HEDDLE_PROJECTS'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  // Cursor sanitizes ambient MCP env. Its native empty-default interpolation preserves launcher
  // identity while letting unset fields fall through to file identity and non-worker defaults.
  const forwarded = client === 'cursor'
    ? Object.fromEntries(IDENTITY_ENV.map((key) => [key, '${' + key + ':-}'])) : {};
  return Object.fromEntries(['heddle', 'heddle-comms'].map((name) => [name, {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'client-mcp.js'), name, dir],
    env: { ...forwarded, ...paths, HEDDLE_CLIENT: client, ...(agent ? { HEDDLE_AGENT: agent, FLEET_AGENT: agent } : {}), ...workerEnv },
    ...(client === 'gemini' ? { timeout: 660_000 } : {}),
  }]));
}

/** Explicit launch overrides make Codex exec work even when it ignores project config layers. */
export function codexClientFlags(dir: string, agent?: string, workerEnv?: Record<string, string>): string[] {
  return Object.entries(serverDefinitions(dir, 'codex', agent, workerEnv)).flatMap(([name, server]) => {
    // Codex's -c key parser splits dotted keys literally (it does not unquote TOML key segments).
    const prefix = `mcp_servers.${name}`;
    return ['-c', `${prefix}.command=${JSON.stringify(server.command)}`, '-c', `${prefix}.args=${JSON.stringify(server.args)}`,
      '-c', `${prefix}.tool_timeout_sec=660`, '-c', `${prefix}.env_vars=${JSON.stringify(FORWARDED_ENV)}`,
      ...(workerEnv?.HEDDLE_WORKER === '1' ? ['-c', `${prefix}.default_tools_approval_mode="approve"`] : []),
      ...Object.entries(server.env).flatMap(([key, value]) => ['-c', `${prefix}.env.${key}=${JSON.stringify(value)}`])];
  });
}

/** Only replace our named command entries; preserve every other native hook. */
function nativeHooks(config: Record<string, unknown>, client: FleetClient, dir: string, agent?: string): Record<string, unknown> {
  const hooks = config.hooks === undefined ? {} : object(config.hooks, 'hooks');
  const next = { ...hooks };
  const events: Record<string, string> = client === 'cursor'
    ? { sessionStart: 'SessionStart', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUse', stop: 'Stop' }
    : client === 'gemini'
      ? { SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', AfterAgent: 'Stop' }
      : { SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit', PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', Stop: 'Stop' };
  for (const [native, event] of Object.entries(events)) {
    const entries = next[native] ?? [];
    if (!Array.isArray(entries)) throw new Error(`hooks.${native} must be an array`);
    const prefix = [process.execPath, '--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'client-hook.js'), client, event, dir];
    const command = hookCommand([...prefix, agent ?? '', '--heddle-fleet-hook']);
    const owns = (value: unknown): boolean => typeof value === 'string' && isHeddleHookCommand(value, prefix);
    const handler = { type: 'command', command, timeout: client === 'gemini' ? 5000 : 5 };
    // Grouped native hooks can mix owned and user handlers; retain foreign siblings.
    const kept = entries.flatMap((entry) => {
      const item = object(entry, `hooks.${native} entry`);
      if (client === 'cursor') return owns(item.command) ? [] : [item];
      if (!Array.isArray(item.hooks)) throw new Error(`hooks.${native} entry.hooks must be an array`);
      const foreign = item.hooks.filter((hook: unknown) => {
        const value = object(hook, 'hook');
        return !owns(value.command);
      });
      return foreign.length ? [{ ...item, hooks: foreign }] : [];
    });
    next[native] = [...kept, client === 'cursor' ? { command, timeout: 5, ...(native === 'stop' ? { loop_limit: 5 } : {}) }
      : { hooks: [{ ...handler, ...(client === 'codex' && event !== 'Stop' && event !== 'PreToolUse' ? { additionalContextLimit: 5000 } : {}) }] }];
  }
  return { ...config, ...(client === 'cursor' ? { version: 1 } : {}), hooks: next };
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
  const schema = client === 'opencode' && !config.$schema ? { $schema: 'https://opencode.ai/config.json' } : {};
  const key = client === 'opencode' ? 'mcp' : 'mcpServers';
  const existing = config[key] === undefined ? {} : object(config[key], `${path}: ${key}`);
  const next = { ...existing };
  for (const [name, def] of Object.entries(servers)) {
    const expected = client === 'opencode'
      ? { type: 'local', command: [def.command, ...def.args], environment: def.env, enabled: true, timeout: 660_000 }
      : def;
    if (Object.hasOwn(existing, name) && !isDeepStrictEqual(existing[name], expected)
      && !isIdentityRebind(existing[name], expected, client)) {
      throw new Error(`MCP server ${name} already has different configuration in ${path}; existing settings were preserved`);
    }
    next[name] = expected;
  }
  if (raw !== null && !schema.$schema && isDeepStrictEqual(existing, next)) return raw;
  return JSON.stringify({ ...config, ...schema, [key]: next }, null, 2) + '\n';
}

/** Reassign a seat or add Cursor's generated empty lineage defaults; preserve all other fields. */
function isIdentityRebind(prior: unknown, expected: unknown, client: FleetClient): boolean {
  const key = client === 'opencode' ? 'environment' : 'env';
  const withoutIdentity = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const config = value as Record<string, unknown>, rawEnv = config[key];
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return value;
    const env = { ...rawEnv } as Record<string, unknown>;
    if (env.HEDDLE_WORKER === '1') return value; // Never rebind a materialized worker.
    delete env.HEDDLE_AGENT; delete env.FLEET_AGENT;
    if (client === 'cursor') for (const name of ['HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT', 'HEDDLE_COMMS_ADDRESS']) {
      if (env[name] === '${' + name + ':-}') delete env[name];
    }
    return { ...config, [key]: env };
  };
  return isDeepStrictEqual(withoutIdentity(prior), withoutIdentity(expected));
}

export interface ClientInstallOptions { dir: string; clients: FleetClient[]; agent?: string; dryRun?: boolean; homeDir?: string; }

/** Native agents can call the installed CLI even when no global `heddle` shim exists. */
export function clientStartupInstructions(): string {
  const windows = process.platform === 'win32';
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'cli.js')];
  const command = windows ? '& ' + argv.map((value) => `'${value.replace(/'/g, "''")}'`).join(' ') : hookCommand(argv);
  const instructions = readFileSync(join(here, '..', 'assets', 'client-startup.md'), 'utf8')
    .replace(/`heddle (?=dispatch|ledger)/g, () => '`' + command + ' ');
  return instructions + (windows ? '\nRun the generated command examples in PowerShell on Windows.\n' : '');
}

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
    let content = client === 'codex' ? tomlConfig(raw ?? '', servers) : jsonConfig(raw, client, servers, path);
    if (client === 'gemini') {
      const config = JSON.parse(content);
      const hooked = nativeHooks(config, client, dir, agent);
      if (!isDeepStrictEqual(config, hooked)) content = JSON.stringify(hooked, null, 2) + '\n';
    }
    steps.push(...plannedFile(path, `client:${client}`, raw, content, dryRun));
    if (client === 'codex' || client === 'cursor') {
      const hookPath = join(dir, `.${client}`, 'hooks.json'), hookRaw = clientFileSource(hookPath);
      const config = hookRaw === null ? {} : checkedJson(hookRaw, hookPath);
      const hooked = nativeHooks(config, client, dir, agent);
      const hookContent = hookRaw !== null && isDeepStrictEqual(config, hooked) ? hookRaw : JSON.stringify(hooked, null, 2) + '\n';
      steps.push(...plannedFile(hookPath, `client:${client}:hooks`, hookRaw, hookContent, dryRun));
    }
    if (client === 'opencode') {
      const pluginPath = join(dir, '.opencode', 'plugins', 'heddle-fleet.js'), pluginRaw = clientFileSource(pluginPath);
      if (pluginRaw !== null && !pluginRaw.startsWith('// Heddle managed native integration.')) throw new Error(`existing OpenCode plugin preserved: ${pluginPath}`);
      const plugin = readFileSync(join(here, '..', 'assets', 'opencode-fleet-plugin.js'), 'utf8')
        .replace("'__HEDDLE_NODE__'", () => JSON.stringify(process.execPath))
        .replace("'__HEDDLE_HOOK__'", () => JSON.stringify(join(here, '..', 'dist', 'client-hook.js')))
        .replace("'__HEDDLE_AGENT__'", () => JSON.stringify(agent ?? ''));
      steps.push(...plannedFile(pluginPath, 'client:opencode:plugin', pluginRaw, plugin, dryRun));
    }
  }
  const guidance = clientStartupInstructions();
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
