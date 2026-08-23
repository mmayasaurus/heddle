import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectRegistry, PROJECTS_SCHEMA_VERSION } from './projects.js';

/** v1 default; HED-96 flips to heddle's fleet/ */
export const V1_CANONICAL_DEFAULT = '/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude';

const WIRED_HOOKS = ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py'] as const;
const OPTIONAL_HOOKS = ['protect-workspace.py', 'require-vault-search.py', 'auto-reindex-vault.py'] as const;
const DISCIPLINE_HOOKS = new Set([...WIRED_HOOKS, ...OPTIONAL_HOOKS]);
const here = dirname(fileURLToPath(import.meta.url));

export interface InstallOptions {
  dir: string; canonical?: string; name?: string; team?: string; agents?: string; room?: string; launcher?: string;
  enforceMemtrace?: boolean; dryRun?: boolean; homeDir?: string;
}
export interface InstallStep {
  step: string; path: string; action: 'ok' | 'create' | 'update' | 'skip' | 'would-create' | 'would-update'; reason?: string; content?: string;
}
export interface InstallPlan { options: Required<Pick<InstallOptions, 'dir' | 'canonical' | 'name' | 'homeDir'>> & InstallOptions; steps: InstallStep[]; }
export interface InstallReport { steps: InstallStep[]; humanSteps: string[]; }

/** The installer and registry share this realpath-or-resolve representation. */
export function canonicalizePath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

export const DISCIPLINE_WIRING: Array<{ event: string; matcher: string; hook: typeof WIRED_HOOKS[number]; args?: string; timeout: number }> = [
  { event: 'SessionStart', matcher: '*', hook: 'agent-identity.py', timeout: 15 },
  { event: 'SessionStart', matcher: '*', hook: 'agent-preflight.py', timeout: 5 },
  { event: 'UserPromptSubmit', matcher: '*', hook: 'remind-owned-prs.py', timeout: 8 },
  { event: 'PreToolUse', matcher: 'Bash', hook: 'require-memtrace-first.py', args: 'deny-recursive-search', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Bash', hook: 'require-memtrace-first.py', args: 'enforce-query', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Grep|Glob|Read', hook: 'require-memtrace-first.py', args: 'enforce-query', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Edit|MultiEdit|Write', hook: 'delegation-nudge.py', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Bash', hook: 'require-memtrace-first.py', args: 'record', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Bash', hook: 'require-pr-sweep.py', args: 'record', timeout: 5 },
  { event: 'PostToolUse', matcher: 'mcp__memtrace__.*', hook: 'require-memtrace-first.py', args: 'record', timeout: 5 },
  { event: 'PostToolUse', matcher: 'mcp__serena__.*', hook: 'require-memtrace-first.py', args: 'record', timeout: 5 },
  { event: 'Stop', matcher: '*', hook: 'require-memtrace-first.py', args: 'stop', timeout: 5 },
];

function readJson(path: string, description: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${description} at ${path} is not valid JSON: ${(error as Error).message}`); }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function stepFor(path: string, step: string, content: string, dryRun: boolean, exists = existsSync(path)): InstallStep {
  const same = exists && readFileSync(path, 'utf8') === content;
  const action = same ? 'ok' : exists ? (dryRun ? 'would-update' : 'update') : (dryRun ? 'would-create' : 'create');
  return { step, path, action, content };
}
function hookCommand(canonical: string, hook: string, args?: string): string {
  const hookPath = join(canonical, 'hooks', hook);
  return `if [ -f "${hookPath}" ]; then python3 "${hookPath}"${args ? ` ${args}` : ''}; else echo "heddle: discipline hook ${hook} MISSING at the canonical — running WITHOUT it (heddle init-project)" >&2; exit 1; fi`;
}
function isDisciplineEntry(entry: any): boolean {
  const command = entry?.command;
  return typeof command === 'string' && [...DISCIPLINE_HOOKS].some((hook) => command.includes(hook));
}
function renderedSettings(path: string, canonical: string): string {
  const source = existsSync(path) ? readJson(path, 'settings.json') : {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`settings.json at ${path} must be a JSON object`);
  const hooks: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(source.hooks ?? {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups as any; continue; }
    const kept = groups.map((group: any) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((entry: any) => !isDisciplineEntry(entry)) : group.hooks }))
      .filter((group: any) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  for (const wiring of DISCIPLINE_WIRING) {
    const groups = hooks[wiring.event] ?? (hooks[wiring.event] = []);
    let group = groups.find((candidate: any) => candidate.matcher === wiring.matcher && Array.isArray(candidate.hooks) && candidate.hooks.every(isDisciplineEntry));
    if (!group) { group = { matcher: wiring.matcher, hooks: [] }; groups.push(group); }
    group.hooks.push({ type: 'command', command: hookCommand(canonical, wiring.hook, wiring.args), timeout: wiring.timeout });
  }
  const { hooks: _oldHooks, ...rest } = source;
  return json({ ...rest, hooks });
}
function installerAsset(...parts: string[]): string { return join(here, '..', ...parts); }
function mcpTemplate(): Record<string, unknown> {
  const path = installerAsset('.mcp.json');
  if (existsSync(path)) {
    const parsed = readJson(path, '.mcp.json');
    if (parsed?.mcpServers?.memtrace && parsed?.mcpServers?.serena) return parsed.mcpServers;
  }
  return { memtrace: { '// TODO: configure': 'configure the memtrace server for this project' }, serena: { '// TODO: configure': 'configure the serena server for this project' } };
}
function rulesContent(canonical: string, file: string): string {
  return `# ${file.replace(/\.md$/, '').replace(/-/g, ' ')}\n\nThis project delegates this discipline rule to the canonical source.\n\nCanonical: ${join(canonical, 'rules', file)}\n\nInvoke/Read the canonical before acting.\n`;
}

export function planInstall(input: InstallOptions): InstallPlan {
  const homeDir = input.homeDir ?? homedir();
  const dir = canonicalizePath(input.dir);
  const canonicalConfig = join(homeDir, '.heddle', 'canonical.json');
  const configCanonical = existsSync(canonicalConfig) ? readJson(canonicalConfig, 'canonical.json')?.canonical : undefined;
  const canonical = canonicalizePath(input.canonical ?? process.env.HEDDLE_CANONICAL ?? configCanonical ?? V1_CANONICAL_DEFAULT);
  const missing = WIRED_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook)));
  if (missing.length) throw new Error(`canonical ${canonical} is missing required discipline hooks: ${missing.join(', ')}`);
  const name = input.name ?? basename(dir);
  const registryPath = join(homeDir, '.heddle', 'projects.json');
  const registry = loadProjectRegistry(registryPath);
  const prior = registry.projects.find((project) => project.name === name);
  if (!prior) {
    const missingFlags = [['team', input.team], ['agents', input.agents], ['room', input.room], ['launcher', input.launcher]].filter(([, value]) => !value).map(([flag]) => `--${flag}`);
    if (missingFlags.length) throw new Error(`first registration requires ${missingFlags.join(', ')}`);
  }
  const dryRun = input.dryRun === true;
  const steps: InstallStep[] = [{ step: 'canonical', path: canonical, action: 'ok', reason: OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).length ? `optional hooks absent: ${OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).join(', ')}` : undefined }];
  const settingsPath = join(dir, '.claude', 'settings.json');
  steps.push(stepFor(settingsPath, 'settings', renderedSettings(settingsPath, canonical), dryRun));
  for (const file of ['pr-review-sweep.md', 'pr-ownership.md', 'worktree-discipline.md']) {
    const path = join(dir, '.claude', 'rules', file);
    steps.push(existsSync(path) ? { step: `rule:${file}`, path, action: 'ok', reason: 'exists' } : stepFor(path, `rule:${file}`, rulesContent(canonical, file), dryRun, false));
  }
  const mcpPath = join(dir, '.mcp.json');
  const existingMcp = existsSync(mcpPath) ? readJson(mcpPath, '.mcp.json') : {};
  const mcpServers = { ...(existingMcp.mcpServers ?? {}) };
  for (const [key, value] of Object.entries(mcpTemplate())) if (!(key in mcpServers)) mcpServers[key] = value;
  steps.push(stepFor(mcpPath, 'mcp', json({ ...existingMcp, mcpServers }), dryRun));
  const ignorePath = join(dir, '.memtraceignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const lines = ignore.split(/\r?\n/).filter(Boolean); for (const entry of ['.worktrees/', '.memdb*/']) if (!lines.includes(entry)) lines.push(entry);
  steps.push(stepFor(ignorePath, 'memtraceignore', lines.join('\n') + '\n', dryRun));
  const gatePath = join(dir, '.claude', 'commands', 'heddle-gate.md');
  if (existsSync(gatePath)) steps.push({ step: 'heddle-gate', path: gatePath, action: 'ok', reason: 'exists' });
  else steps.push(stepFor(gatePath, 'heddle-gate', readFileSync(installerAsset('.claude', 'commands', 'heddle-gate.md'), 'utf8'), dryRun, false));
  const project = prior ? { ...prior, workspaceRoots: prior.workspaceRoots.includes(dir) ? prior.workspaceRoots : [...prior.workspaceRoots, dir], agentIds: input.agents ? input.agents.split(',').map((agent) => agent.trim()).filter(Boolean) : prior.agentIds, linearTeam: input.team ?? prior.linearTeam, defaultRoom: input.room ?? prior.defaultRoom, launcher: input.launcher ?? prior.launcher } : { name, workspaceRoots: [dir], agentIds: input.agents!.split(',').map((agent) => agent.trim()).filter(Boolean), linearTeam: input.team!, defaultRoom: input.room!, launcher: input.launcher! };
  const nextRegistry = { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: prior ? registry.projects.map((candidate) => candidate.name === name ? project : candidate) : [...registry.projects, project] };
  steps.push(stepFor(registryPath, 'registry', json(nextRegistry), dryRun));
  if (input.enforceMemtrace) {
    const enforcePath = join(homeDir, '.heddle', 'memtrace-enforce.json'); const existing = existsSync(enforcePath) ? readJson(enforcePath, 'memtrace-enforce.json') : {};
    steps.push(stepFor(enforcePath, 'memtrace-enforce', json({ ...existing, [dir]: true }), dryRun));
  } else steps.push({ step: 'memtrace-enforce', path: join(homeDir, '.heddle', 'memtrace-enforce.json'), action: 'ok', reason: 'not requested' });
  return { options: { ...input, dir, canonical, name, homeDir }, steps };
}

export function applyInstall(plan: InstallPlan): InstallReport {
  for (const step of plan.steps) {
    if (!step.content || step.action === 'ok' || step.action === 'skip') continue;
    mkdirSync(dirname(step.path), { recursive: true }); writeFileSync(step.path, step.content);
  }
  const root = plan.options.dir;
  return { steps: plan.steps, humanSteps: [`watch_directory(path=${root}, repo_id=${basename(root)})`, 'confirm index freshness', 'Linear team/labels — HED-299 ws3'] };
}
