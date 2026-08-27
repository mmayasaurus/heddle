import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectRegistry, PROJECTS_SCHEMA_VERSION, validateRegistry } from './projects.js';

/** v1 default; HED-96 flips to heddle's fleet/ */
export const V1_CANONICAL_DEFAULT = '/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude';

const WIRED_HOOKS = ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py'] as const;
const OPTIONAL_HOOKS = ['protect-workspace.py', 'require-vault-search.py', 'auto-reindex-vault.py'] as const;
const DISCIPLINE_HOOKS = new Set(WIRED_HOOKS);
const here = dirname(fileURLToPath(import.meta.url));

export interface InstallOptions {
  dir: string; canonical?: string; name?: string; team?: string; agents?: string; room?: string; launcher?: string;
  enforceMemtrace?: boolean; dryRun?: boolean; homeDir?: string; showContent?: boolean;
}
export interface InstallStep {
  step: string; path: string; action: 'ok' | 'create' | 'update' | 'skip' | 'would-create' | 'would-update'; reason?: string; content?: string; bytes?: number;
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
  { event: 'Stop', matcher: '*', hook: 'require-pr-sweep.py', args: 'enforce-stop', timeout: 10 },
  { event: 'SubagentStop', matcher: '*', hook: 'require-memtrace-first.py', args: 'stop', timeout: 5 },
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
  return typeof command === 'string' && [...DISCIPLINE_HOOKS].some((hook) =>
    new RegExp('(^|[\\s"\\x27/])hooks/' + hook.replace('.', '\\.') + '(\\b|["\\x27 ])').test(command));
}
function renderedSettings(path: string, canonical: string): string {
  const source = existsSync(path) ? readJson(path, 'settings.json') : {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`settings.json at ${path} must be a JSON object`);
  const hooks: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(source.hooks ?? {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups as any; continue; }
    const merged: any[] = [];
    const byMatcher = new Map<string, any>();
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { merged.push(group); continue; }
      const retained = group.hooks.filter((entry: any) => !isDisciplineEntry(entry));
      const existing = byMatcher.get(group.matcher);
      if (existing) {
        for (const [key, value] of Object.entries(group)) if (!(key in existing)) existing[key] = value;
        existing.hooks.push(...retained);
      }
      else {
        const next = { ...group, hooks: retained };
        byMatcher.set(group.matcher, next);
        merged.push(next);
      }
    }
    hooks[event] = merged;
  }
  for (const wiring of DISCIPLINE_WIRING) {
    const groups = hooks[wiring.event] ?? (hooks[wiring.event] = []);
    let group = groups.find((candidate: any) => candidate?.matcher === wiring.matcher && Array.isArray(candidate.hooks));
    if (!group) { group = { matcher: wiring.matcher, hooks: [] }; groups.push(group); }
    group.hooks.push({ type: 'command', command: hookCommand(canonical, wiring.hook, wiring.args), timeout: wiring.timeout });
  }
  const { hooks: _oldHooks, ...rest } = source;
  return json({ ...rest, hooks });
}
function installerAsset(...parts: string[]): string { return join(here, '..', ...parts); }
function mcpTemplate(): Record<string, unknown> | null {
  const path = installerAsset('.mcp.json');
  if (existsSync(path)) {
    const parsed = readJson(path, '.mcp.json');
    if (parsed?.mcpServers?.memtrace && parsed?.mcpServers?.serena) return parsed.mcpServers;
  }
  return null;
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
  const supplied = (flag: 'team' | 'agents' | 'room' | 'launcher'): string | undefined => {
    const value = input[flag];
    if (value !== undefined && !value.trim()) throw new Error('--' + flag + ' must not be empty');
    return value;
  };
  const team = supplied('team'); const agents = supplied('agents'); const room = supplied('room'); const launcher = supplied('launcher');
  const parsedAgents = agents?.split(',').map((agent) => agent.trim()).filter(Boolean);
  if (agents !== undefined && !parsedAgents?.length) throw new Error('--agents must include at least one agent');
  if (!input.name && prior && !prior.workspaceRoots.includes(dir)) throw new Error('project name "' + name + '" is already registered to a different root; provide an explicit --name');
  if (!prior) {
    const missingFlags = [['team', team], ['agents', parsedAgents?.length ? agents : undefined], ['room', room], ['launcher', launcher]].filter(([, value]) => !value).map(([flag]) => '--' + flag);
    if (missingFlags.length) throw new Error(`first registration requires ${missingFlags.join(', ')}`);
  }
  const dryRun = input.dryRun === true;
  const steps: InstallStep[] = [{ step: 'canonical', path: canonical, action: 'ok', reason: OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).length ? `optional hooks absent: ${OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).join(', ')}` : undefined }];
  const settingsPath = join(dir, '.claude', 'settings.json');
  steps.push(stepFor(settingsPath, 'settings', renderedSettings(settingsPath, canonical), dryRun));
  for (const file of ['pr-review-sweep.md', 'pr-ownership.md', 'worktree-discipline.md']) {
    const path = join(dir, '.claude', 'rules', file);
    steps.push(existsSync(path) ? { step: `rule:${file}`, path, action: 'skip', reason: 'exists' } : stepFor(path, `rule:${file}`, rulesContent(canonical, file), dryRun, false));
  }
  const mcpPath = join(dir, '.mcp.json');
  const template = mcpTemplate();
  if (!template) steps.push({ step: 'mcp', path: mcpPath, action: 'skip', reason: 'no template (heddle/.mcp.json)' });
  else {
    const existingMcp = existsSync(mcpPath) ? readJson(mcpPath, '.mcp.json') : {};
    const mcpServers = { ...(existingMcp.mcpServers ?? {}) };
    for (const [key, value] of Object.entries(template)) if (!(key in mcpServers)) mcpServers[key] = value;
    steps.push(stepFor(mcpPath, 'mcp', json({ ...existingMcp, mcpServers }), dryRun));
  }
  const ignorePath = join(dir, '.memtraceignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const missingIgnore = ['.worktrees/', '.memdb*/'].filter((entry) => !ignore.split(/\r?\n/).includes(entry));
  const newline = ignore.includes('\r\n') ? '\r\n' : '\n';
  const ignoreContent = missingIgnore.length ? `${ignore}${ignore && !ignore.endsWith('\n') ? newline : ''}${missingIgnore.join(newline)}${newline}` : ignore;
  steps.push(stepFor(ignorePath, 'memtraceignore', ignoreContent, dryRun));
  const gatePath = join(dir, '.claude', 'commands', 'heddle-gate.md');
  if (existsSync(gatePath)) steps.push({ step: 'heddle-gate', path: gatePath, action: 'skip', reason: 'exists' });
  else steps.push(stepFor(gatePath, 'heddle-gate', readFileSync(installerAsset('.claude', 'commands', 'heddle-gate.md'), 'utf8'), dryRun, false));
  const project = prior ? { ...prior, workspaceRoots: prior.workspaceRoots.includes(dir) ? prior.workspaceRoots : [...prior.workspaceRoots, dir], agentIds: parsedAgents ?? prior.agentIds, linearTeam: team ?? prior.linearTeam, defaultRoom: room ?? prior.defaultRoom, launcher: launcher ?? prior.launcher } : { name, workspaceRoots: [dir], agentIds: parsedAgents!, linearTeam: team!, defaultRoom: room!, launcher: launcher! };
  const nextRegistry = { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: prior ? registry.projects.map((candidate) => candidate.name === name ? project : candidate) : [...registry.projects, project] };
  validateRegistry(nextRegistry, registryPath);
  steps.push(stepFor(registryPath, 'registry', json(nextRegistry), dryRun));
  const enforcePath = join(homeDir, '.heddle', 'memtrace-enforce.json'); const existing = existsSync(enforcePath) ? readJson(enforcePath, 'memtrace-enforce.json') : {};
  steps.push(stepFor(enforcePath, 'memtrace-enforce', json({ ...existing, [dir]: input.enforceMemtrace === true }), dryRun));
  return { options: { ...input, dir, canonical, name, homeDir }, steps };
}

export function applyInstall(plan: InstallPlan, dryRun = false): InstallReport {
  for (const step of plan.steps) {
    if (dryRun || !step.content || step.action === 'ok' || step.action === 'skip') continue;
    mkdirSync(dirname(step.path), { recursive: true }); writeFileSync(step.path, step.content);
  }
  const root = plan.options.dir;
  return { steps: plan.steps, humanSteps: [`watch_directory(path=${root}, repo_id=${basename(root)})`, 'confirm index freshness', 'Linear team/labels — HED-299 ws3'] };
}
