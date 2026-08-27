import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAncestorOrEqual, PROJECTS_SCHEMA_VERSION, validateRegistry } from './projects.js';

const WIRED_HOOKS = ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py'] as const;
const OPTIONAL_HOOKS = ['protect-workspace.py', 'require-vault-search.py', 'auto-reindex-vault.py'] as const;
const DISCIPLINE_HOOKS = new Set(WIRED_HOOKS);
const here = dirname(fileURLToPath(import.meta.url));

export interface InstallOptions {
  dir: string; canonical?: string; name?: string; team?: string; agents?: string; room?: string; launcher?: string;
  enforceMemtrace?: boolean; dryRun?: boolean; homeDir?: string; showContent?: boolean;
}
export interface InstallStep {
  step: string; path: string; action: 'ok' | 'create' | 'update' | 'skip' | 'would-create' | 'would-update'; reason?: string; content?: string; bytes?: number; expectedContent?: string | null;
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
function json(value: unknown, indent: string | number = 2): string { return JSON.stringify(value, null, indent) + '\n'; }
function jsonIndent(source: string | undefined): string | number {
  return source?.match(/\n([ \t]+)"/)?.[1] ?? 2;
}
let atomicWriteSequence = 0;
function atomicWriteFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${atomicWriteSequence++}.tmp`);
  try {
    writeFileSync(temporary, content);
    if (existsSync(path)) chmodSync(temporary, statSync(path).mode);
    renameSync(temporary, path);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve the original write/rename failure */ }
  }
}
function stepFor(path: string, step: string, content: string, dryRun: boolean, exists = existsSync(path)): InstallStep {
  const same = exists && readFileSync(path, 'utf8') === content;
  const action = same ? 'ok' : exists ? (dryRun ? 'would-update' : 'update') : (dryRun ? 'would-create' : 'create');
  return { step, path, action, content };
}
function hookCommand(canonical: string, hook: string, args?: string): string {
  const hookPath = join(canonical, 'hooks', hook);
  return `if [ -f "${hookPath}" ]; then python3 "${hookPath}"${args ? ` ${args}` : ''}; else echo "heddle: discipline hook ${hook} MISSING at the canonical — running WITHOUT it (heddle init-project)" >&2; exit 1; fi`;
}
function assertShellSafeCanonical(canonical: string): void {
  if (/["`$;\r\n]/.test(canonical)) {
    throw new Error(`canonical path contains unsupported shell character: ${JSON.stringify(canonical)}`);
  }
}
function disciplineHook(entry: any): typeof WIRED_HOOKS[number] | undefined {
  const command = entry?.command;
  if (typeof command !== 'string') return undefined;
  return [...DISCIPLINE_HOOKS].find((hook) => {
    const index = command.indexOf(`/hooks/${hook}`);
    const terminator = command[index + `/hooks/${hook}`.length];
    // A bare filename is not owned; a suffix such as `.py.bak` is also not owned.
    return index >= 0 && (terminator === undefined || /[\s"']/.test(terminator));
  });
}
function preservedHookGroups(source: any, path: string, misplaced: string[], targets: Map<string, { group: any; index?: number }>): Record<string, any[]> {
  const hooks: Record<string, any[]> = {};
  for (const [event, groups] of Object.entries(source.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new Error(`settings.json at ${path}: hooks.${event} must be an array`);
    const preserved: any[] = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { preserved.push(group); continue; }
      const key = `${event}\u0000${group.matcher}`;
      const isWiredMatcher = DISCIPLINE_WIRING.some((wiring) => wiring.event === event && wiring.matcher === group.matcher);
      const retained: any[] = [];
      let firstDisciplineIndex: number | undefined;
      for (const entry of group.hooks) {
        const hook = disciplineHook(entry);
        if (!hook) { retained.push(entry); continue; }
        if (firstDisciplineIndex === undefined) firstDisciplineIndex = retained.length;
        if (!isWiredMatcher) misplaced.push(`${event}/${group.matcher} ${hook}`);
      }
      const next = { ...group, hooks: retained };
      preserved.push(next);
      if (isWiredMatcher && !targets.has(key)) targets.set(key, { group: next, index: firstDisciplineIndex });
    }
    hooks[event] = preserved;
  }
  return hooks;
}
function wireDisciplineHooks(hooks: Record<string, any[]>, targets: Map<string, { group: any; index?: number }>, canonical: string): void {
  const wiringByTarget = new Map<string, typeof DISCIPLINE_WIRING>();
  for (const entry of DISCIPLINE_WIRING) {
    const key = `${entry.event}\u0000${entry.matcher}`;
    const existing = wiringByTarget.get(key);
    if (existing) existing.push(entry);
    else wiringByTarget.set(key, [entry]);
  }
  for (const [key, wiring] of wiringByTarget) {
    const [event, matcher] = key.split('\u0000');
    const groups = hooks[event] ?? (hooks[event] = []);
    let target = targets.get(key);
    if (!target) {
      const group = { matcher, hooks: [] as any[] };
      groups.push(group);
      target = { group };
    }
    const block = wiring.map((entry) => ({ type: 'command', command: hookCommand(canonical, entry.hook, entry.args), timeout: entry.timeout }));
    target.group.hooks.splice(target.index ?? target.group.hooks.length, 0, ...block);
  }
}
function renderedSettings(path: string, canonical: string): { content: string; misplaced: string[] } {
  const source = existsSync(path) ? readJson(path, 'settings.json') : {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`settings.json at ${path} must be a JSON object`);
  const misplaced: string[] = [];
  const targets = new Map<string, { group: any; index?: number }>();
  const hooks = preservedHookGroups(source, path, misplaced, targets);
  wireDisciplineHooks(hooks, targets, canonical);
  const { hooks: _oldHooks, ...rest } = source;
  return { content: json({ ...rest, hooks }), misplaced };
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
function valueFor(flag: string, value: string | undefined): string | undefined {
  if (value !== undefined && (!value.trim() || value.startsWith('--'))) throw new Error(`${flag} requires a value`);
  return value;
}
function endOfJsonValue(source: string, start: number): number {
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') depth++;
    if (char === '}' || char === ']') { depth--; if (depth === 0) return index + 1; }
    if (depth === 0 && (char === ',' || char === ']')) return index;
  }
  throw new Error('projects.json has an unterminated JSON value');
}
function projectObjectRange(source: string, name: string): { start: number; end: number } | undefined {
  const projects = source.indexOf('"projects"');
  const arrayStart = projects < 0 ? -1 : source.indexOf('[', projects);
  if (arrayStart < 0) return undefined;
  for (let index = arrayStart + 1; source[index] !== ']';) {
    while (/\s|,/.test(source[index])) index++;
    const end = endOfJsonValue(source, index);
    const candidate = JSON.parse(source.slice(index, end));
    if (candidate?.name === name) return { start: index, end };
    index = end;
  }
  return undefined;
}
function replaceProjectInRawRegistry(source: string | undefined, name: string, project: unknown): string {
  if (source === undefined) return json({ schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [project] });
  const range = projectObjectRange(source, name);
  if (!range) return source;
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  const prefix = source.slice(lineStart, range.start).match(/^[ \t]*/)?.[0] ?? '';
  const replacement = JSON.stringify(project, null, jsonIndent(source)).replace(/\n/g, `\n${prefix}`);
  return source.slice(0, range.start) + replacement + source.slice(range.end);
}
function registryContent(raw: any, rawContent: string | undefined, prior: any, project: any, name: string): string {
  if (prior && rawContent !== undefined) return replaceProjectInRawRegistry(rawContent, name, project);
  return json({ ...raw, projects: prior ? raw.projects.map((candidate: any) => candidate.name === name ? project : candidate) : [...raw.projects, project] }, jsonIndent(rawContent));
}

export function planInstall(input: InstallOptions): InstallPlan {
  const homeDir = input.homeDir ?? homedir();
  const requestedDir = resolve(input.dir);
  const targetParent = dirname(requestedDir);
  if (!existsSync(requestedDir) && !existsSync(targetParent)) {
    throw new Error(`target parent does not exist: ${targetParent} — create it or fix the path`);
  }
  // The parent exists by the guard above, so this is stable before and after mkdirSync creates the leaf.
  const dir = existsSync(requestedDir) ? canonicalizePath(requestedDir) : join(realpathSync.native(targetParent), basename(requestedDir));
  const canonicalHome = canonicalizePath(homeDir);
  if (dir === '/') throw new Error('refuses filesystem root as an install target');
  if (dir === canonicalHome) throw new Error('refuses the home directory as an install target');
  const canonicalConfig = join(homeDir, '.heddle', 'canonical.json');
  const configCanonical = existsSync(canonicalConfig) ? readJson(canonicalConfig, 'canonical.json')?.canonical : undefined;
  const canonicalSource = valueFor('--canonical', input.canonical) ?? process.env.HEDDLE_CANONICAL ?? configCanonical;
  if (!canonicalSource) throw new Error('canonical is required: pass --canonical <path>, set HEDDLE_CANONICAL, or create ~/.heddle/canonical.json');
  const canonical = canonicalizePath(canonicalSource);
  assertShellSafeCanonical(canonical);
  const missing = WIRED_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook)));
  if (missing.length) throw new Error(`canonical ${canonical} is missing required discipline hooks: ${missing.join(', ')}`);
  const name = valueFor('--name', input.name) ?? basename(dir);
  const registryPath = join(homeDir, '.heddle', 'projects.json');
  const rawRegistryContent = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : undefined;
  const rawRegistry = rawRegistryContent === undefined ? { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] } : readJson(registryPath, 'projects.json');
  const registry = validateRegistry(rawRegistry, registryPath);
  if (registry.projects.some((project) => project.workspaceRoots.some((root) => dir !== root && isAncestorOrEqual(dir, root)))) throw new Error(`refuses install target ${dir}: it is an ancestor of a registered workspace root`);
  const namedPrior = registry.projects.find((project) => project.name === name);
  const prior = registry.projects.find((project) => project.workspaceRoots.includes(dir)) ?? namedPrior;
  const rawPrior = prior ? rawRegistry.projects.find((project: any) => project.name === prior.name) : undefined;
  const supplied = (flag: 'team' | 'agents' | 'room' | 'launcher'): string | undefined => valueFor('--' + flag, input[flag]);
  const team = supplied('team'); const agents = supplied('agents'); const room = supplied('room'); const launcher = supplied('launcher');
  const parsedAgents = agents?.split(',').map((agent) => agent.trim()).filter(Boolean);
  if (agents !== undefined && !parsedAgents?.length) throw new Error('--agents must include at least one agent');
  if (!input.name && namedPrior && !namedPrior.workspaceRoots.includes(dir)) throw new Error('project name "' + name + '" is already registered to a different root; provide an explicit --name');
  if (!prior) {
    const missingFlags = [['team', team], ['agents', parsedAgents?.length ? agents : undefined], ['room', room], ['launcher', launcher]].filter(([, value]) => !value).map(([flag]) => '--' + flag);
    if (missingFlags.length) throw new Error(`first registration requires ${missingFlags.join(', ')}`);
  }
  const dryRun = input.dryRun === true;
  const steps: InstallStep[] = [{ step: 'canonical', path: canonical, action: 'ok', reason: OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).length ? `optional hooks absent: ${OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook))).join(', ')}` : undefined }];
  const settingsPath = join(dir, '.claude', 'settings.json');
  const settings = renderedSettings(settingsPath, canonical);
  const settingsStep = stepFor(settingsPath, 'settings', settings.content, dryRun);
  if (settings.misplaced.length) settingsStep.reason = `moved ${settings.misplaced.length} misplaced discipline entr${settings.misplaced.length === 1 ? 'y' : 'ies'}: ${settings.misplaced.join(', ')}`;
  steps.push(settingsStep);
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
  const projectName = prior?.name ?? name;
  const project = prior
    ? {
      ...rawPrior,
      workspaceRoots: prior.workspaceRoots.includes(dir) ? rawPrior.workspaceRoots : [...rawPrior.workspaceRoots, dir],
      agentIds: parsedAgents ?? rawPrior.agentIds,
      linearTeam: team ?? rawPrior.linearTeam,
      defaultRoom: room ?? rawPrior.defaultRoom,
      launcher: launcher ?? rawPrior.launcher,
    }
    : { name: projectName, workspaceRoots: [dir], agentIds: parsedAgents!, linearTeam: team!, defaultRoom: room!, launcher: launcher! };
  const nextRegistry = { ...rawRegistry, projects: prior ? rawRegistry.projects.map((candidate: any) => candidate.name === projectName ? project : candidate) : [...rawRegistry.projects, project] };
  validateRegistry(nextRegistry, registryPath);
  steps.push({ ...stepFor(registryPath, 'registry', registryContent(rawRegistry, rawRegistryContent, rawPrior, project, projectName), dryRun), expectedContent: rawRegistryContent ?? null });
  const enforcePath = join(homeDir, '.heddle', 'memtrace-enforce.json'); const existing = existsSync(enforcePath) ? readJson(enforcePath, 'memtrace-enforce.json') : {};
  const aliases = Object.entries(existing).filter(([key]) => canonicalizePath(key) === dir);
  const priorEnforceValue = aliases[0]?.[1];
  const nextEnforcement = Object.fromEntries(Object.entries(existing).filter(([key]) => canonicalizePath(key) !== dir));
  steps.push(stepFor(enforcePath, 'memtrace-enforce', json({ ...nextEnforcement, [dir]: input.enforceMemtrace === true ? true : (priorEnforceValue ?? false) }), dryRun));
  return { options: { ...input, dir, canonical, name, homeDir }, steps };
}

export function applyInstall(plan: InstallPlan, dryRun = false): InstallReport {
  const skipWrites = dryRun || plan.options.dryRun === true;
  for (const step of plan.steps) {
    if (skipWrites || !step.content || step.action === 'ok' || step.action === 'skip') continue;
    mkdirSync(dirname(step.path), { recursive: true });
    if (step.expectedContent !== undefined) {
      const current = existsSync(step.path) ? readFileSync(step.path, 'utf8') : null;
      if (current !== step.expectedContent) throw new Error('registry changed underneath this install plan — re-run heddle init-project');
    }
    atomicWriteFile(step.path, step.content);
  }
  const root = plan.options.dir;
  return { steps: plan.steps, humanSteps: [`watch_directory(path=${root}, repo_id=${basename(root)})`, 'confirm index freshness', 'Linear team/labels — HED-299 ws3'] };
}

export function redactReport(report: InstallReport, showContent: boolean, homeDir: string): InstallReport {
  if (showContent) return report;
  const heddleDir = resolve(homeDir, '.heddle');
  return { ...report, steps: report.steps.map(({ content, ...step }) => content && isAncestorOrEqual(heddleDir, resolve(step.path))
    ? { ...step, bytes: Buffer.byteLength(content) }
    : { ...step, ...(content ? { content } : {}) }) };
}
