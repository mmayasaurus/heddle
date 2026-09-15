import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { isAncestorOrEqual, PROJECTS_SCHEMA_VERSION, validateRegistry, type Project } from './projects.js';
import { resolveCatalogRoot } from './rules/lifecycle.js';
import { loadRules } from './rules/load.js';
import { RuleIdPattern } from './rules/schema.js';
import type { HookRuleSelection } from './wizard/hooks-choose.js';

const WIRED_HOOKS = ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py'] as const;
const OPTIONAL_HOOKS = ['protect-workspace.py', 'require-vault-search.py', 'auto-reindex-vault.py'] as const;
const DISCIPLINE_HOOKS = new Set(WIRED_HOOKS);
const here = dirname(fileURLToPath(import.meta.url));

export interface InstallOptions {
  dir: string; canonical?: string; name?: string; team?: string; agents?: string; room?: string; launcher?: string;
  enforceMemtrace?: boolean; dryRun?: boolean; homeDir?: string; showContent?: boolean;
  hookRules?: HookRuleSelection[]; hookCatalogRoot?: string;
}
export interface InstallStep {
  step: string; path: string; action: 'ok' | 'create' | 'update' | 'skip' | 'would-create' | 'would-update'; reason?: string; content?: string; bytes?: number; expectedContent?: string | null;
  /** POSIX mode for the written file (e.g. 0o755 for an executable launcher). When set, applyInstall
   *  chmods the file to it after the atomic write; when unset, an existing file's mode is preserved and
   *  a new file takes the umask default (HED-671, enabling the HED-669 launcher-gen step). */
  mode?: number;
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

function parseJson(text: string, path: string, description: string): any {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${description} at ${path} is not valid JSON: ${(error as Error).message}`); }
}
function readJson(path: string, description: string): any {
  return parseJson(readFileSync(path, 'utf8'), path, description);
}
function json(value: unknown, indent: string | number = 2): string { return JSON.stringify(value, null, indent) + '\n'; }
function jsonIndent(source: string | undefined): string | number {
  // \u0022 is a literal double-quote char, kept as an escape rather than a bare quote so
  // Codacy's LOC lexer does not mis-read the regex quote as a string-literal open and
  // mis-count this 3-line function as spanning to end-of-file. Behaviour is unchanged.
  return source?.match(/\n([ \t]+)\u0022/)?.[1] ?? 2;
}
let atomicWriteSequence = 0;
function atomicWriteFile(path: string, content: string, mode?: number): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${atomicWriteSequence++}.tmp`);
  try {
    writeFileSync(temporary, content);
    // An explicit mode (e.g. an executable launcher) wins; else preserve an existing file's mode.
    // A brand-new file with no explicit mode keeps the umask default (unchanged pre-HED-671 behaviour).
    const targetMode = mode ?? (existsSync(path) ? statSync(path).mode : undefined);
    if (targetMode !== undefined) chmodSync(temporary, targetMode);
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
// ── HED-536: consumer-side hook-rules bridge ───────────────────────────────────────────────────
// When the operator opts into hook rules (via the 471 chooser / 472 preset tiers), wire the compiled
// bridge (src/hook.ts → dist/hook.js) into the CONSUMER project's settings so its seeded rules run at
// hook time. Consumer-only: this never wires heddle's OWN repo — turning the fleet's own rules on is a
// separate, operator-gated decision. Selection-gated + inert when empty, so a merge with zero selected
// rules is byte-identical to the pre-bridge installer.

// The bridge is a sibling of this module in dist/ (`here` === dist/ at runtime), so it is
// join(here, 'hook.js') — NOT installerAsset(), which is join(here, '..', …) for repo-root assets.
// Absolute, so the wired command is cwd-independent.
function hookBridgePath(): string { return join(here, 'hook.js'); }

// Distinctive text present ONLY in a heddle-generated bridge command, so a re-run recognises and
// replaces a prior bridge entry (stripHookBridge) instead of duplicating it.
const HOOK_BRIDGE_MARKER = 'heddle hook-rules bridge';
function hookBridgeEntry(entry: any): boolean {
  // Recognise a heddle-generated bridge by BOTH its marker and the actual bridge invocation, so a
  // user's own command that merely contains the marker phrase (but not the /hook.js invocation) is
  // never stripped as if it were generated (codeant review).
  return typeof entry?.command === 'string' && entry.command.includes(HOOK_BRIDGE_MARKER) && entry.command.includes('/hook.js');
}

// Bake the absolute node binary (process.execPath — the fnm/nvm-safe HEDDLE_BIN discipline: a hook
// shell often has no version-managed node on PATH), the absolute bridge, and the consumer's own rules
// dir into --rules (so evaluation is CLAUDE_PROJECT_DIR-independent and unaffected by resolveRulesRoot
// precedence). Mirror the bridge shebang's --disable-warning=ExperimentalWarning so node:sqlite's
// experimental warning never reaches hook stderr. Fail LOUD (exit 1) when node or the bridge is missing
// — a broken install should be visible, like the discipline .py hookCommand; the bridge itself still
// fails OPEN once it runs.
function hookBridgeCommand(rulesDir: string): string {
  const node = process.execPath;
  const bridge = hookBridgePath();
  assertShellSafeCanonical(node);
  assertShellSafeCanonical(bridge);
  assertShellSafeCanonical(rulesDir);
  return `if [ -x "${node}" ] && [ -f "${bridge}" ]; then "${node}" --disable-warning=ExperimentalWarning "${bridge}" --rules "${rulesDir}"; else echo "${HOOK_BRIDGE_MARKER}: missing bridge ${bridge} or node ${node} — hook rules NOT evaluated; re-run heddle init-project" >&2; exit 1; fi`;
}

// The (event, matcher) registrations the SELECTED rules need. The bridge self-filters by event and
// re-checks match.tool internally, so we register exactly one entry per distinct event, with matcher =
// the union of that event's tools ("*" when any selected rule for the event matches every tool).
// Build the matcher from the rules that will ACTUALLY be evaluated: the consumer's already-seeded
// <dir>/rules (what the bridge reads via --rules), falling back to the catalog for ids not yet seeded
// on a fresh install. Reading the catalog alone would drift the wired matcher from a stale seeded rule
// whose event/tool the catalog later changed (renderHookRulesSteps is skip-if-exists), silently
// narrowing the matcher so the rule never fires (qodo/codeant review). A selected id in neither is a
// hard error, not a silent no-op.
function hookBridgeWiring(selection: HookRuleSelection[], catalogRoot: string, rulesDir: string): Array<{ event: string; matcher: string }> {
  if (!selection.length) return [];
  // existsSync guard: on a fresh install the consumer rules dir is not seeded yet — skip loadRules so it
  // does not emit an ENOENT "rule ignored" note to stderr (installer stderr must stay clean); fall back
  // to the catalog, which is exactly what renderHookRulesSteps will seed.
  const consumer = new Map((existsSync(rulesDir) ? loadRules(rulesDir) : []).map((rule) => [rule.id, rule]));
  const catalog = new Map(loadRules(catalogRoot).map((rule) => [rule.id, rule]));
  const toolsByEvent = new Map<string, Set<string>>();
  for (const { id } of selection) {
    const rule = consumer.get(id) ?? catalog.get(id);
    if (!rule) throw new Error(`hook rule '${id}' not found in catalog ${catalogRoot}`);
    const tools = rule.match.tool === undefined ? ['*'] : (Array.isArray(rule.match.tool) ? rule.match.tool : [rule.match.tool]);
    const forEvent = toolsByEvent.get(rule.event) ?? new Set<string>();
    for (const tool of tools) forEvent.add(tool);
    toolsByEvent.set(rule.event, forEvent);
  }
  return [...toolsByEvent].sort(([a], [b]) => a.localeCompare(b)).map(([event, tools]) => ({
    event,
    matcher: tools.has('*') ? '*' : [...tools].sort().join('|'),
  }));
}

// Remove any prior bridge entry so a re-run does not duplicate it. Drop a group only when OUR removal
// emptied it — never a user's pre-existing empty group nor a refilled discipline group.
function stripHookBridge(hooks: Record<string, any[]>): void {
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return true;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((entry: any) => !hookBridgeEntry(entry));
      return !(group.hooks.length === 0 && group.hooks.length < before);
    });
  }
}

// Append one bridge group per registration (its own group, decoupled from the discipline splice
// machinery; Claude Code allows duplicate matchers). Always appended last, so strip+rewire is
// byte-stable across runs.
function wireHookBridge(hooks: Record<string, any[]>, selection: HookRuleSelection[], catalogRoot: string, rulesDir: string): void {
  const wiring = hookBridgeWiring(selection, catalogRoot, rulesDir);
  if (!wiring.length) return;
  const command = hookBridgeCommand(rulesDir);
  for (const { event, matcher } of wiring) {
    const groups = hooks[event] ?? (hooks[event] = []);
    groups.push({ matcher, hooks: [{ type: 'command', command }] });
  }
}

function renderedSettings(path: string, canonical: string, selection: HookRuleSelection[], catalogRoot: string, rulesDir: string): { content: string; misplaced: string[]; raw: string | undefined } {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const source = raw === undefined ? {} : parseJson(raw, path, 'settings.json');
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`settings.json at ${path} must be a JSON object`);
  const misplaced: string[] = [];
  const targets = new Map<string, { group: any; index?: number }>();
  const hooks = preservedHookGroups(source, path, misplaced, targets);
  wireDisciplineHooks(hooks, targets, canonical);
  // Only touch the bridge when a selection is provided: a re-run WITHOUT selected rules leaves any
  // existing bridge intact (consistent with seeded rule YAML persisting across re-runs), rather than
  // silently stripping the operator's earlier opt-in (qodo/cursor/codeant review). A fresh install
  // with no selection stays inert (nothing to strip, nothing wired).
  if (selection.length) {
    stripHookBridge(hooks);
    wireHookBridge(hooks, selection, catalogRoot, rulesDir);
  }
  const { hooks: _oldHooks, ...rest } = source;
  return { content: json({ ...rest, hooks }), misplaced, raw };
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
export function replaceProjectInRawRegistry(source: string | undefined, name: string, project: unknown): string {
  if (source === undefined) return json({ schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [project] });
  const range = projectObjectRange(source, name);
  if (!range) return source;
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  const prefix = source.slice(lineStart, range.start).match(/^[ \t]*/)?.[0] ?? '';
  let replacement = JSON.stringify(project, null, jsonIndent(source)).replace(/\n/g, `\n${prefix}`);
  // `gates` needs no raw-text splicing: registryStep spreads rawPrior into the rebuilt project, so
  // the field survives STRUCTURALLY through serialization (a regex splice over raw JSON can match a
  // "gates": sequence inside a string value — codeant on PR #112).
  return source.slice(0, range.start) + replacement + source.slice(range.end);
}
export function registryContent(raw: any, rawContent: string | undefined, prior: any, project: any, name: string): string {
  if (prior && rawContent !== undefined) return replaceProjectInRawRegistry(rawContent, name, project);
  return json({ ...raw, projects: prior ? raw.projects.map((candidate: any) => candidate.name === name ? project : candidate) : [...raw.projects, project] }, jsonIndent(rawContent));
}

function resolveTarget(input: InstallOptions): { homeDir: string; dir: string } {
  const homeDir = input.homeDir ?? homedir();
  const requestedDir = resolve(input.dir);
  const targetParent = dirname(requestedDir);
  if (!existsSync(requestedDir) && !existsSync(targetParent)) {
    throw new Error(`target parent does not exist: ${targetParent} — create it or fix the path`);
  }
  // The parent exists by the guard above, so this is stable before and after mkdirSync creates the leaf.
  const dir = existsSync(requestedDir) ? canonicalizePath(requestedDir) : join(realpathSync.native(targetParent), basename(requestedDir));
  if (dir === '/') throw new Error('refuses filesystem root as an install target');
  if (dir === canonicalizePath(homeDir)) throw new Error('refuses the home directory as an install target');
  return { homeDir, dir };
}
function resolveCanonical(input: InstallOptions, homeDir: string): string {
  const canonicalConfig = join(homeDir, '.heddle', 'canonical.json');
  const configCanonical = existsSync(canonicalConfig) ? readJson(canonicalConfig, 'canonical.json')?.canonical : undefined;
  // Trim $HEDDLE_CANONICAL and treat an empty/whitespace value as unset, matching how the setup
  // wizard's canonical step normalizes the same variable — otherwise a whitespace-padded env makes
  // setup record a clean path while init-project (env still set) rejects the raw one (HED-640 review).
  const canonicalSource = valueFor('--canonical', input.canonical) ?? (process.env.HEDDLE_CANONICAL?.trim() || undefined) ?? configCanonical;
  if (!canonicalSource) throw new Error('canonical is required: pass --canonical <path>, set HEDDLE_CANONICAL, or create ~/.heddle/canonical.json');
  const { canonical, missing } = validateCanonical(canonicalSource);
  if (missing.length) throw new Error(`canonical ${canonical} is missing required discipline hooks: ${missing.join(', ')}`);
  return canonical;
}

export function validateCanonical(canonicalSource: string): { canonical: string; missing: string[] } {
  const canonical = canonicalizePath(canonicalSource);
  assertShellSafeCanonical(canonical);
  const missing = WIRED_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook)));
  return { canonical, missing };
}
function registryState(homeDir: string): { path: string; content: string | undefined; raw: any; registry: any } {
  const path = join(homeDir, '.heddle', 'projects.json');
  const content = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  // Parse the SAME captured bytes we later CAS against (expectedContent), never a second read that
  // could diverge from the snapshot (HED-84 review, ledger 652).
  const raw = content === undefined ? { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] } : parseJson(content, path, 'projects.json');
  return { path, content, raw, registry: validateRegistry(raw, path) };
}
function defaultLauncherPath(homeDir: string, name: string): string {
  // Derived when --launcher is omitted on a FIRST registration so the registry `launcher` field and
  // the HED-669 launcher-gen step share ONE resolved path. Guard against a name that would escape
  // ~/.heddle via a path separator or traversal segment — such a name must pass --launcher explicitly.
  if (/[/\\]/.test(name) || name === '..' || name === '.') {
    throw new Error(`cannot derive a default launcher path for project name ${JSON.stringify(name)} (contains a path separator or traversal segment); pass --launcher explicitly`);
  }
  return join(homeDir, '.heddle', `launch-${name}.sh`);
}
function registrationDetails(input: InstallOptions, dir: string, homeDir: string, registry: any, rawRegistry: any): any {
  const name = valueFor('--name', input.name) ?? basename(dir);
  if (registry.projects.some((project: any) => project.workspaceRoots.some((root: string) => dir !== root && isAncestorOrEqual(dir, root)))) throw new Error(`refuses install target ${dir}: it is an ancestor of a registered workspace root`);
  const namedPrior = registry.projects.find((project: any) => project.name === name);
  const prior = registry.projects.find((project: any) => project.workspaceRoots.includes(dir)) ?? namedPrior;
  const rawPrior = prior ? rawRegistry.projects.find((project: any) => project.name === prior.name) : undefined;
  const supplied = (flag: 'team' | 'agents' | 'room' | 'launcher'): string | undefined => valueFor('--' + flag, input[flag]);
  const team = supplied('team'); const agents = supplied('agents'); const room = supplied('room');
  // --launcher is optional now: unsupplied on a FIRST registration derives ~/.heddle/launch-<name>.sh
  // (single source with the launcher-gen step); on a re-init it stays undefined and falls back to the
  // prior entry's launcher in resolveProjectEntry (HED-671).
  const launcher = supplied('launcher') ?? (prior ? undefined : defaultLauncherPath(homeDir, name));
  const parsedAgents = agents?.split(',').map((agent) => agent.trim()).filter(Boolean);
  if (agents !== undefined && !parsedAgents?.length) throw new Error('--agents must include at least one agent');
  if (!input.name && namedPrior && !namedPrior.workspaceRoots.includes(dir)) throw new Error('project name "' + name + '" is already registered to a different root; provide an explicit --name');
  if (!prior) {
    const missingFlags = [['team', team], ['agents', parsedAgents?.length ? agents : undefined], ['room', room]].filter(([, value]) => !value).map(([flag]) => '--' + flag);
    if (missingFlags.length) throw new Error(`first registration requires ${missingFlags.join(', ')}`);
  }
  return { name, prior, rawPrior, team, room, launcher, parsedAgents };
}
function canonicalStep(canonical: string): InstallStep {
  const absent = OPTIONAL_HOOKS.filter((hook) => !existsSync(join(canonical, 'hooks', hook)));
  return { step: 'canonical', path: canonical, action: 'ok', reason: absent.length ? `optional hooks absent: ${absent.join(', ')}` : undefined };
}
function renderSettingsStep(dir: string, canonical: string, selection: HookRuleSelection[], catalogRoot: string, dryRun: boolean): InstallStep {
  const path = join(dir, '.claude', 'settings.json');
  // `dir` is already canonical (resolveTarget realpaths it); the consumer's seeded rules dir is a
  // stable subdir, baked into the bridge's --rules so evaluation is cwd-/env-independent.
  const settings = renderedSettings(path, canonical, selection, catalogRoot, join(dir, 'rules'));
  const step: InstallStep = { ...stepFor(path, 'settings', settings.content, dryRun), expectedContent: settings.raw ?? null };
  if (settings.misplaced.length) step.reason = `moved ${settings.misplaced.length} misplaced discipline entr${settings.misplaced.length === 1 ? 'y' : 'ies'}: ${settings.misplaced.join(', ')}`;
  return step;
}
function renderRulesSteps(dir: string, canonical: string, dryRun: boolean): InstallStep[] {
  return ['pr-review-sweep.md', 'pr-ownership.md', 'worktree-discipline.md'].map((file) => {
    const path = join(dir, '.claude', 'rules', file);
    return existsSync(path) ? { step: `rule:${file}`, path, action: 'skip', reason: 'exists' } : stepFor(path, `rule:${file}`, rulesContent(canonical, file), dryRun, false);
  });
}
export function renderHookRulesSteps(dir: string, selection: HookRuleSelection[], catalogRoot: string, dryRun: boolean): InstallStep[] {
  return selection.flatMap(({ id, enforce }) => {
    if (!RuleIdPattern.test(id)) throw new Error(`invalid hook rule id '${id}'`);
    const catalogRule = join(catalogRoot, `${id}.yaml`);
    const rulePath = join(dir, 'rules', `${id}.yaml`);
    const source = readFileSync(catalogRule, 'utf8');
    const document = parseDocument(source);
    document.set('enforce', enforce);
    const ruleStep = existsSync(rulePath)
      ? { step: `hook-rule:${id}`, path: rulePath, action: 'skip' as const, reason: 'exists' }
      : stepFor(rulePath, `hook-rule:${id}`, document.toString(), dryRun, false);
    const catalogFixture = join(catalogRoot, 'tests', `${id}.jsonl`);
    if (!existsSync(catalogFixture)) return [ruleStep];
    const fixturePath = join(dir, 'rules', 'tests', `${id}.jsonl`);
    const fixtureStep = existsSync(fixturePath)
      ? { step: `hook-rule-test:${id}`, path: fixturePath, action: 'skip' as const, reason: 'exists' }
      : stepFor(fixturePath, `hook-rule-test:${id}`, readFileSync(catalogFixture, 'utf8'), dryRun, false);
    return [ruleStep, fixtureStep];
  });
}
function renderMcpStep(dir: string, dryRun: boolean): InstallStep {
  const path = join(dir, '.mcp.json');
  const template = mcpTemplate();
  if (!template) return { step: 'mcp', path, action: 'skip', reason: 'no template (heddle/.mcp.json)' };
  const rawContent = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const existingMcp = rawContent === undefined ? {} : parseJson(rawContent, path, '.mcp.json');
  const mcpServers = { ...existingMcp.mcpServers };
  for (const [key, value] of Object.entries(template)) if (!(key in mcpServers)) mcpServers[key] = value;
  return { ...stepFor(path, 'mcp', json({ ...existingMcp, mcpServers }), dryRun), expectedContent: rawContent ?? null };
}
function renderIgnoreStep(dir: string, dryRun: boolean): InstallStep {
  const path = join(dir, '.memtraceignore');
  // absent (undefined) != empty (''): merge treats absent as empty, but expectedContent must be null
  // for an absent file so a fresh install is not falsely aborted by the pre-pass (current=null vs '').
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const ignore = raw ?? '';
  const missing = ['.worktrees/', '.memdb*/'].filter((entry) => !ignore.split(/\r?\n/).includes(entry));
  const newline = ignore.includes('\r\n') ? '\r\n' : '\n';
  const content = missing.length ? `${ignore}${ignore && !ignore.endsWith('\n') ? newline : ''}${missing.join(newline)}${newline}` : ignore;
  return { ...stepFor(path, 'memtraceignore', content, dryRun), expectedContent: raw ?? null };
}
function renderGateStep(dir: string, dryRun: boolean): InstallStep {
  const path = join(dir, '.claude', 'commands', 'heddle-gate.md');
  return existsSync(path) ? { step: 'heddle-gate', path, action: 'skip', reason: 'exists' } : stepFor(path, 'heddle-gate', readFileSync(installerAsset('.claude', 'commands', 'heddle-gate.md'), 'utf8'), dryRun, false);
}
// Generic, tenant-neutral lifecycle slash commands (HED-478): seeded into the consumer's
// `.claude/commands/` — one file each, skip-if-present, exactly like /heddle-gate. Sourced from
// heddle's `assets/commands/` (NOT its own fleet-specific `.claude/commands/{startup,closeout}.md`,
// which are fleet-internal and never ship); `assets/` is inside the public-scrub scan so these stay
// tenant-clean.
const LIFECYCLE_COMMANDS = ['startup.md', 'closeout.md', 'handoff.md', 'heddle-usage.md'] as const;
function renderLifecycleCommandSteps(dir: string, dryRun: boolean): InstallStep[] {
  return LIFECYCLE_COMMANDS.map((file) => {
    const path = join(dir, '.claude', 'commands', file);
    return existsSync(path)
      ? { step: `command:${file}`, path, action: 'skip', reason: 'exists' }
      : stepFor(path, `command:${file}`, readFileSync(installerAsset('assets', 'commands', file), 'utf8'), dryRun, false);
  });
}
/**
 * The single source of truth for a project's registry entry — the exact object registryStep writes to
 * projects.json, resolving the new-vs-re-init fallbacks in ONE place. Exported so the HED-669
 * launcher-gen step consumes the SAME resolved agentIds + launcher rather than re-deriving them (which
 * would drift on a re-init that omits --agents/--launcher). `tracker` is intentionally absent from a
 * new entry — projects.ts defaults it to 'linear' on read, so the written file carries no redundant
 * default. The return type is Project-without-tracker (tracker is a read-time default, never written
 * here); .agentIds and .launcher — the fields the launcher-gen step reads — are present on both branches.
 */
export function resolveProjectEntry(details: any, dir: string): Omit<Project, 'tracker'> {
  return details.prior
    ? { ...details.rawPrior, workspaceRoots: details.prior.workspaceRoots.includes(dir) ? details.rawPrior.workspaceRoots : [...details.rawPrior.workspaceRoots, dir], agentIds: details.parsedAgents ?? details.rawPrior.agentIds, linearTeam: details.team ?? details.rawPrior.linearTeam, defaultRoom: details.room ?? details.rawPrior.defaultRoom, launcher: details.launcher ?? details.rawPrior.launcher }
    : { name: details.name, workspaceRoots: [dir], agentIds: details.parsedAgents!, linearTeam: details.team!, defaultRoom: details.room!, launcher: details.launcher! };
}
function registryStep(input: InstallOptions, dir: string, state: any, details: any, dryRun: boolean): InstallStep {
  const project = resolveProjectEntry(details, dir);
  const projectName = project.name;
  const nextRegistry = { ...state.raw, projects: details.prior ? state.raw.projects.map((candidate: any) => candidate.name === projectName ? project : candidate) : [...state.raw.projects, project] };
  validateRegistry(nextRegistry, state.path);
  return { ...stepFor(state.path, 'registry', registryContent(state.raw, state.content, details.rawPrior, project, projectName), dryRun), expectedContent: state.content ?? null };
}
function enforceMarkerStep(input: InstallOptions, dir: string, homeDir: string, dryRun: boolean): InstallStep {
  const path = join(homeDir, '.heddle', 'memtrace-enforce.json');
  const rawContent = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const existing = rawContent === undefined ? {} : parseJson(rawContent, path, 'memtrace-enforce.json');
  const aliases = Object.entries(existing).filter(([key]) => canonicalizePath(key) === dir);
  const priorValue = aliases[0]?.[1];
  const next = Object.fromEntries(Object.entries(existing).filter(([key]) => canonicalizePath(key) !== dir));
  // expectedContent makes this a compare-and-swap like the registry step: a concurrent init on a
  // different root that rewrote memtrace-enforce.json between plan and apply aborts instead of
  // dropping the other root's key (last-writer-wins). Verified by the CAS pre-pass in applyInstall.
  return { ...stepFor(path, 'memtrace-enforce', json({ ...next, [dir]: input.enforceMemtrace === true ? true : (priorValue ?? false) }), dryRun), expectedContent: rawContent ?? null };
}

export function planInstall(input: InstallOptions): InstallPlan {
  const { homeDir, dir } = resolveTarget(input);
  const canonical = resolveCanonical(input, homeDir);
  const state = registryState(homeDir);
  const details = registrationDetails(input, dir, homeDir, state.registry, state.raw);
  const dryRun = input.dryRun === true;
  const hookCatalogRoot = input.hookCatalogRoot ?? resolveCatalogRoot();
  const steps = [canonicalStep(canonical), renderSettingsStep(dir, canonical, input.hookRules ?? [], hookCatalogRoot, dryRun), ...renderRulesSteps(dir, canonical, dryRun), ...renderHookRulesSteps(dir, input.hookRules ?? [], hookCatalogRoot, dryRun), renderMcpStep(dir, dryRun), renderIgnoreStep(dir, dryRun), renderGateStep(dir, dryRun), ...renderLifecycleCommandSteps(dir, dryRun), registryStep(input, dir, state, details, dryRun), enforceMarkerStep(input, dir, homeDir, dryRun)];
  return { options: { ...input, dir, canonical, name: details.name, homeDir }, steps };
}

export function applyInstall(plan: InstallPlan, dryRun = false): InstallReport {
  const skipWrites = dryRun || plan.options.dryRun === true;
  // CAS pre-pass: verify EVERY compare-and-swap precondition (registry, memtrace-enforce, and every
  // read-then-merge target file — settings / .mcp.json / .memtraceignore) BEFORE writing anything.
  // Otherwise a stale expectedContent throws only when its step is reached — after earlier target-repo
  // files were already written — leaving a half-installed repo. Checking first makes a raced apply
  // abort before any mutation. Residual: the sub-millisecond interleave between this pre-pass and the
  // write loop is NOT closed without a filesystem lock — a rare, recoverable (re-run is idempotent)
  // race tracked as HED-418.
  if (!skipWrites) {
    for (const step of plan.steps) {
      if (step.expectedContent === undefined) continue;
      const current = existsSync(step.path) ? readFileSync(step.path, 'utf8') : null;
      if (current !== step.expectedContent) throw new Error(`${step.step} changed underneath this install plan — re-run heddle init-project`);
    }
  }
  for (const step of plan.steps) {
    if (skipWrites || !step.content || step.action === 'ok' || step.action === 'skip') continue;
    mkdirSync(dirname(step.path), { recursive: true });
    atomicWriteFile(step.path, step.content, step.mode);
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
