import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyInstall, DISCIPLINE_WIRING, planInstall, redactReport } from '../src/init-project.js';
import { useTempResources } from './helpers.js';

const WIRED_HOOKS = [
  'agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py',
  'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py',
];

function fixture(base: string) {
  const canonical = join(base, 'canonical');
  const homeDir = join(base, 'home');
  const target = join(homeDir, 'target');
  mkdirSync(join(canonical, 'hooks'), { recursive: true });
  for (const hook of WIRED_HOOKS) writeFileSync(join(canonical, 'hooks', hook), '');
  mkdirSync(target, { recursive: true });
  return { canonical, target, homeDir };
}

function options(base: string) {
  const { canonical, target, homeDir } = fixture(base);
  return { dir: target, canonical, homeDir, name: 'toy', team: 'NEW', agents: 'Z', room: '#toy', launcher: 'resume-toy.sh' };
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function entryShape(event: string, matcher: string, entry: any) {
  const match = entry.command.match(/python3 "([^"]+)\/hooks\/([^"]+)"(?: ([^;]+))?;/);
  return { event, matcher, hook: match?.[2], ...(match?.[3] ? { args: match[3] } : {}), timeout: entry.timeout };
}

describe('init-project', () => {
  const { tempDir } = useTempResources('heddle-init-project-test-');

  it('installs discipline files and registers a fresh project', () => {
    const opts = options(tempDir());
    const plan = planInstall(opts);
    expect(plan.steps.filter((step) => step.action === 'create').map((step) => step.step)).toEqual(expect.arrayContaining([
      'settings', 'rule:pr-review-sweep.md', 'rule:pr-ownership.md', 'rule:worktree-discipline.md', 'memtraceignore', 'heddle-gate', 'registry', 'memtrace-enforce',
    ]));
    applyInstall(plan);
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    const commands = Object.values(settings.hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks.map((hook: any) => hook.command)));
    expect(commands).toHaveLength(14);
    expect(commands.every((command: string) => command.includes(opts.canonical))).toBe(true);
    const registry = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8'));
    expect(registry.projects[0]).toMatchObject({ name: 'toy', workspaceRoots: [realpathSync.native(opts.dir)] });
  });

  it('regression PR#112 — re-registration preserves prior gates in the written registry', () => {
    const opts = options(tempDir());
    const gates = { byFolderName: { acme: 'repo-workspace' } };
    mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
    writeFileSync(join(opts.homeDir, '.heddle', 'projects.json'), JSON.stringify({
      schemaVersion: 1,
      projects: [{
        name: 'toy', workspaceRoots: [opts.dir], agentIds: ['Z'], linearTeam: 'OLD',
        defaultRoom: '#old', launcher: 'old.sh', gates,
      }],
    }));
    applyInstall(planInstall({ ...opts, team: 'NEW' }));
    const registry = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8'));
    expect(registry.projects[0]).toMatchObject({ linearTeam: 'NEW', gates });
    expect(registry.projects[0].gates).toEqual(gates);
  });

  it('never purges a suffixed backup of a discipline hook (.py.bak / .py-disabled)', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'python /old/hooks/require-pr-sweep.py.bak record' },
      { type: 'command', command: 'python /old/hooks/delegation-nudge.py-disabled' },
    ] }] } }));
    applyInstall(planInstall(opts));
    const text = readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8');
    expect(text).toContain('require-pr-sweep.py.bak');
    expect(text).toContain('delegation-nudge.py-disabled');
  });

  it('is byte-identical on a second run', () => {
    const opts = options(tempDir());
    applyInstall(planInstall(opts));
    const files = [join(opts.dir, '.claude', 'settings.json'), join(opts.dir, '.claude', 'rules', 'pr-review-sweep.md'), join(opts.dir, '.claude', 'rules', 'pr-ownership.md'), join(opts.dir, '.claude', 'rules', 'worktree-discipline.md'), join(opts.dir, '.memtraceignore'), join(opts.dir, '.claude', 'commands', 'heddle-gate.md'), join(opts.homeDir, '.heddle', 'projects.json'), join(opts.homeDir, '.heddle', 'memtrace-enforce.json')];
    const hashes = files.map(sha);
    expect(planInstall(opts).steps.every((step) => step.action === 'ok' || step.action === 'skip')).toBe(true);
    applyInstall(planInstall(opts));
    expect(files.map(sha)).toEqual(hashes);
  });

  it('does not write during dry-run planning, including under homeDir', () => {
    const opts = { ...options(tempDir()), dryRun: true };
    const before = readdirSync(opts.dir);
    const plan = planInstall(opts);
    expect(readdirSync(opts.dir)).toEqual(before);
    expect(existsSync(join(opts.homeDir, '.heddle'))).toBe(false);
    expect(plan.steps.some((step) => step.action === 'would-create')).toBe(true);
  });

  it('renders discipline wiring in the first matching group while preserving user hooks and groups', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ keep: true, hooks: { PreToolUse: [{ matcher: 'Custom', extra: 'preserve', hooks: [{ type: 'command', command: 'echo custom' }] }, { matcher: 'Bash', keep: true, hooks: [{ type: 'command', command: 'echo custom' }, { type: 'command', command: 'python old/hooks/require-memtrace-first.py deny-recursive-search' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'python old/hooks/require-memtrace-first.py record' }] }] } }));
    applyInstall(planInstall(opts));
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.keep).toBe(true);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Custom', extra: 'preserve' });
    const bash = settings.hooks.PreToolUse.filter((group: any) => group.matcher === 'Bash');
    expect(bash).toHaveLength(2);
    expect(bash[0].hooks[0].command).toBe('echo custom');
    expect(bash[0].hooks).toHaveLength(3);
    expect(bash[1].hooks).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain('old/hooks/require-memtrace-first.py');
  });

  it('reports and removes discipline entries placed under an unwired matcher', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [
      { type: 'command', command: 'python /old/hooks/require-memtrace-first.py enforce-query' },
    ] }] } }));
    const plan = planInstall(opts);
    expect(plan.steps.find((step) => step.step === 'settings')?.reason).toBe('moved 1 misplaced discipline entry: PreToolUse/Write require-memtrace-first.py');
    applyInstall(plan);
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse.find((group: any) => group.matcher === 'Write').hooks).toEqual([]);
  });

  it('keeps a discipline block at the first removed entry position within its group', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'echo user1' },
      { type: 'command', command: 'python /old/hooks/require-memtrace-first.py record' },
      { type: 'command', command: 'echo user2' },
    ] }] } }));
    applyInstall(planInstall(opts));
    const hooks = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.find((group: any) => group.matcher === 'Bash').hooks;
    expect(hooks.map((entry: any) => entry.command)).toMatchObject(['echo user1', expect.stringContaining('require-memtrace-first.py'), expect.stringContaining('require-memtrace-first.py'), 'echo user2']);
    expect(hooks).toHaveLength(4);
  });

  it('keeps separate same-matcher groups around intervening groups', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user1' }, { type: 'command', command: 'python /old/hooks/require-memtrace-first.py record' }] },
      { matcher: 'Custom', hooks: [{ type: 'command', command: 'echo custom' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user2' }, { type: 'command', command: 'python /old/hooks/require-memtrace-first.py enforce-query' }] },
    ] } }));
    applyInstall(planInstall(opts));
    const groups = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse;
    expect(groups.map((group: any) => group.matcher)).toEqual(['Bash', 'Custom', 'Bash', 'Grep|Glob|Read', 'Edit|MultiEdit|Write']);
    expect(groups[0].hooks.map((entry: any) => entry.command)).toHaveLength(3);
    expect(groups[0].hooks[0].command).toBe('echo user1');
    expect(groups[1].hooks[0].command).toBe('echo custom');
    expect(groups[2].hooks.map((entry: any) => entry.command)).toEqual(['echo user2']);
  });

  it('redacts only heddle configuration contents unless show-content is selected', () => {
    const opts = options(tempDir());
    const report = applyInstall(planInstall(opts));
    const redacted = redactReport(report, false, opts.homeDir);
    const registry = redacted.steps.find((step) => step.step === 'registry')!;
    const settings = redacted.steps.find((step) => step.step === 'settings')!;
    expect(registry).toMatchObject({ bytes: expect.any(Number) });
    expect(registry.content).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('agentIds');
    expect(settings.content).toBeDefined();
    expect(redactReport(report, true, opts.homeDir).steps.find((step) => step.step === 'registry')?.content).toContain('"agentIds": [\n        "Z"');
  });

  it('does not apply a plan built for dry-run and includes its human watch step', () => {
    const opts = { ...options(tempDir()), dryRun: true };
    const report = applyInstall(planInstall(opts));
    expect(existsSync(join(opts.dir, '.claude', 'settings.json'))).toBe(false);
    expect(report.humanSteps).toContain(`watch_directory(path=${realpathSync.native(opts.dir)}, repo_id=target)`);
  });

  it('fails before writes when a wired canonical hook is missing', () => {
    const opts = options(tempDir());
    // A second canonical avoids deleting fixture files during test setup.
    const broken = join(opts.canonical, 'broken'); mkdirSync(join(broken, 'hooks'), { recursive: true });
    for (const hook of WIRED_HOOKS.slice(1)) writeFileSync(join(broken, 'hooks', hook), '');
    expect(() => planInstall({ ...opts, canonical: broken })).toThrow(/agent-identity\.py/);
    expect(existsSync(join(opts.dir, '.claude'))).toBe(false);
  });

  it('requires all first-registration fleet flags without writing a registry', () => {
    const opts = options(tempDir());
    const { team, agents, room, launcher, ...incomplete } = opts;
    expect(() => planInstall(incomplete)).toThrow(/--team, --agents, --room, --launcher/);
    expect(existsSync(join(opts.homeDir, '.heddle', 'projects.json'))).toBe(false);
  });

  it('leaves corrupt settings untouched', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    const path = join(opts.dir, '.claude', 'settings.json'); writeFileSync(path, '{bad');
    expect(() => planInstall(opts)).toThrow(/settings\.json.*valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{bad');
  });

  it('rejects a non-array hook group with the installer error before writing', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: {} } }));
    expect(() => planInstall(opts)).toThrow(`settings.json at ${realpathSync.native(join(opts.dir, '.claude', 'settings.json'))}: hooks.PreToolUse must be an array`);
    expect(existsSync(join(opts.homeDir, '.heddle', 'projects.json'))).toBe(false);
  });

  it('refuses a canonical path that cannot safely be rendered in a shell command', () => {
    const opts = options(tempDir());
    const unsafe = join(tempDir(), 'canonical$unsafe');
    mkdirSync(join(unsafe, 'hooks'), { recursive: true });
    for (const hook of WIRED_HOOKS) writeFileSync(join(unsafe, 'hooks', hook), '');
    expect(() => planInstall({ ...opts, canonical: unsafe })).toThrow(/canonical path contains unsupported shell character/);
  });

  it('refuses a missing target parent rather than creating it', () => {
    const opts = options(tempDir());
    const parent = join(tempDir(), 'missing-parent');
    const target = join(parent, 'target');
    expect(() => planInstall({ ...opts, dir: target })).toThrow(`target parent does not exist: ${parent} — create it or fix the path`);
    expect(existsSync(parent)).toBe(false);
  });

  it('writes the per-root memtrace opt-in marker, preserving a prior enforcement choice and other roots', () => {
    const opts = options(tempDir());
    applyInstall(planInstall({ ...opts, enforceMemtrace: true }));
    expect(JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))[realpathSync.native(opts.dir)]).toBe(true);
    applyInstall(planInstall(opts));
    expect(JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))[realpathSync.native(opts.dir)]).toBe(true);
    const off = options(tempDir());
    mkdirSync(join(off.homeDir, '.heddle'), { recursive: true });
    writeFileSync(join(off.homeDir, '.heddle', 'memtrace-enforce.json'), JSON.stringify({ '/other': true }));
    applyInstall(planInstall(off));
    expect(JSON.parse(readFileSync(join(off.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))).toMatchObject({ '/other': true, [realpathSync.native(off.dir)]: false });
  });

  it('keeps one canonical memtrace-enforce key for a target created after planning', () => {
    const base = tempDir(); const realParent = join(base, 'real-parent'); const aliasParent = join(base, 'alias-parent');
    mkdirSync(realParent); symlinkSync(realParent, aliasParent);
    const opts = { ...options(base), dir: join(aliasParent, 'newthing') };
    applyInstall(planInstall(opts));
    const second = planInstall(opts);
    const enforce = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'));
    expect(Object.keys(enforce)).toEqual([join(realpathSync.native(realParent), 'newthing')]);
    expect(second.steps.find((step) => step.step === 'memtrace-enforce')?.action).toBe('ok');
  });

  it('matches all 14 live heddle discipline entries exactly', () => {
    const settingsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const live = Object.entries(settings.hooks).flatMap(([event, groups]: [string, any]) => groups.flatMap((group: any) =>
      group.hooks.map((entry: any) => entryShape(event, group.matcher, entry)).filter((entry: any) => WIRED_HOOKS.includes(entry.hook)),
    ));
    expect(DISCIPLINE_WIRING).toEqual(live);
  });

  it('preserves user commands that merely mention a wired hook basename', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo "audit require-pr-sweep.py"' }] }] } }));
    applyInstall(planInstall(opts));
    expect(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8')).toContain('echo \\"audit require-pr-sweep.py\\"');
  });

  it('rejects empty registration flags and duplicate agents before writing', () => {
    const opts = options(tempDir());
    expect(() => planInstall({ ...opts, agents: ',' })).toThrow(/--agents/);
    mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
    writeFileSync(join(opts.homeDir, '.heddle', 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'other', workspaceRoots: [join(opts.homeDir, 'other')], agentIds: ['A'], linearTeam: 'O', defaultRoom: '#o', launcher: 'o.sh' }] }));
    expect(() => planInstall({ ...opts, agents: 'A' })).toThrow(/agent id "A" is claimed by both/);
    applyInstall(planInstall({ ...opts, agents: 'Z' }));
    expect(() => planInstall({ ...opts, team: '' })).toThrow(/--team/);
  });

  it('preserves registration fields and unrelated raw registry objects byte-for-byte', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
    const other = { name: 'other', workspaceRoots: [join(opts.homeDir, 'some', '.', 'other')], agentIds: ['O'], linearTeam: 'O', defaultRoom: '#o', launcher: 'o.sh', unknownKey: { preserve: true } };
    const source = JSON.stringify({ schemaVersion: 1, projects: [other] }, null, 4) + '\n';
    const originalOther = source.match(/        \{[\s\S]*?\n        \}/)?.[0];
    writeFileSync(join(opts.homeDir, '.heddle', 'projects.json'), source);
    applyInstall(planInstall(opts));
    const registry = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8'));
    expect(registry.projects[0]).toEqual(other);
    expect(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8')).toContain(originalOther);
  });

  it('cleans up an atomic temp file when a target settings rename fails', () => {
    const opts = options(tempDir()); const plan = planInstall(opts); const settingsPath = join(opts.dir, '.claude', 'settings.json');
    mkdirSync(settingsPath, { recursive: true });
    expect(() => applyInstall(plan)).toThrow();
    expect(readdirSync(dirname(settingsPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('guards a defaulted name collision with a different root', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
    writeFileSync(join(opts.homeDir, '.heddle', 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'target', workspaceRoots: [join(opts.homeDir, 'somewhere-else')], agentIds: ['Z'], linearTeam: 'NEW', defaultRoom: '#toy', launcher: 'resume-toy.sh' }] }));
    expect(() => planInstall({ ...opts, name: undefined })).toThrow(/explicit --name/);
  });

  it('appends memtrace ignores without rewriting existing CRLF bytes', () => {
    const opts = options(tempDir()); const path = join(opts.dir, '.memtraceignore');
    writeFileSync(path, 'custom\r\n\r\n'); applyInstall(planInstall(opts));
    expect(readFileSync(path, 'utf8')).toBe('custom\r\n\r\n.worktrees/\r\n.memdb*/\r\n');
    const before = readFileSync(path); applyInstall(planInstall(opts)); expect(readFileSync(path)).toEqual(before);
  });

  it('skips MCP without a heddle template and preserves existing other servers', () => {
    const opts = options(tempDir()); writeFileSync(join(opts.dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    const plan = planInstall(opts); expect(plan.steps.find((step) => step.step === 'mcp')).toMatchObject({ action: 'skip', reason: 'no template (heddle/.mcp.json)' });
    applyInstall(plan); expect(JSON.parse(readFileSync(join(opts.dir, '.mcp.json'), 'utf8')).mcpServers).toEqual({ other: { command: 'other' } });
  });

  it('uses flag, environment, then canonical.json and requires a canonical source otherwise', () => {
    const opts = options(tempDir()); const configCanonical = join(tempDir(), 'config'); mkdirSync(join(configCanonical, 'hooks'), { recursive: true }); for (const hook of WIRED_HOOKS) writeFileSync(join(configCanonical, 'hooks', hook), '');
    const envCanonical = join(tempDir(), 'env'); mkdirSync(join(envCanonical, 'hooks'), { recursive: true }); for (const hook of WIRED_HOOKS) writeFileSync(join(envCanonical, 'hooks', hook), '');
    mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true }); writeFileSync(join(opts.homeDir, '.heddle', 'canonical.json'), JSON.stringify({ canonical: configCanonical }));
    const old = process.env.HEDDLE_CANONICAL; process.env.HEDDLE_CANONICAL = envCanonical;
    const { canonical, ...withoutFlag } = opts;
    try {
      expect(planInstall(withoutFlag).options.canonical).toBe(realpathSync.native(envCanonical));
      expect(planInstall({ ...withoutFlag, canonical: opts.canonical }).options.canonical).toBe(realpathSync.native(opts.canonical));
      delete process.env.HEDDLE_CANONICAL;
      expect(planInstall(withoutFlag).options.canonical).toBe(realpathSync.native(configCanonical));
      const defaultOpts = options(tempDir());
      const { canonical: _defaultCanonical, ...withoutSources } = defaultOpts;
      expect(() => planInstall(withoutSources)).toThrow(/--canonical.*HEDDLE_CANONICAL.*canonical\.json/);
    }
    finally { if (old === undefined) delete process.env.HEDDLE_CANONICAL; else process.env.HEDDLE_CANONICAL = old; }
  });

  it('reports settings update once and copies heddle-gate bytes exactly', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {}, keep: true }, null, 2) + '\n');
    expect(planInstall(opts).steps.find((step) => step.step === 'settings')?.action).toBe('update');
    applyInstall(planInstall(opts));
    expect(planInstall(opts).steps.find((step) => step.step === 'settings')?.action).toBe('ok');
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'commands', 'heddle-gate.md');
    expect(readFileSync(join(opts.dir, '.claude', 'commands', 'heddle-gate.md'))).toEqual(readFileSync(source));
  });

  it('seeds the generic lifecycle commands from assets/commands and copies their bytes exactly (HED-478)', () => {
    const opts = options(tempDir());
    const plan = planInstall(opts);
    expect(plan.steps.filter((step) => step.action === 'create').map((step) => step.step)).toEqual(expect.arrayContaining([
      'command:startup.md', 'command:closeout.md', 'command:handoff.md', 'command:usage.md',
    ]));
    applyInstall(plan);
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'commands');
    for (const file of ['startup.md', 'closeout.md', 'handoff.md', 'usage.md']) {
      expect(readFileSync(join(opts.dir, '.claude', 'commands', file))).toEqual(readFileSync(join(assetsDir, file)));
    }
    // Seeded once, never rewritten: a second plan reports every command step as skip.
    expect(planInstall(opts).steps.filter((step) => step.step.startsWith('command:')).every((step) => step.action === 'skip')).toBe(true);
  });

  describe('regression PR#91 — installer safety and lossless registry updates', () => {
    it('rejects home and filesystem-root targets before any write', () => {
      const opts = options(tempDir());
      expect(() => planInstall({ ...opts, dir: opts.homeDir })).toThrow(/refuses.*home directory/i);
      expect(existsSync(join(opts.homeDir, '.heddle'))).toBe(false);
      expect(() => planInstall({ ...opts, dir: '/' })).toThrow(/refuses.*filesystem root/i);
      expect(existsSync(join(opts.homeDir, '.heddle'))).toBe(false);
    });

    it('rejects a flag token passed as a required registration value', () => {
      const opts = options(tempDir());
      expect(() => planInstall({ ...opts, team: '--agents' })).toThrow(/--team/);
    });

    it('updates a custom-named project by its canonical workspace root on a bare re-run', () => {
      const opts = options(tempDir());
      applyInstall(planInstall({ ...opts, name: 'custom' }));
      applyInstall(planInstall({ ...opts, name: undefined, team: undefined, agents: undefined, room: undefined, launcher: undefined }));
      const projects = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8')).projects;
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ name: 'custom', workspaceRoots: [realpathSync.native(opts.dir)] });
    });

    it('fails rather than silently overwriting a registry changed after planning', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
      const registryPath = join(opts.homeDir, '.heddle', 'projects.json');
      writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ name: 'before', workspaceRoots: [join(opts.homeDir, 'before')], agentIds: ['B'], linearTeam: 'B', defaultRoom: '#b', launcher: 'before.sh' }] }));
      const plan = planInstall(opts);
      writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ name: 'other', workspaceRoots: [join(opts.homeDir, 'other')], agentIds: ['O'], linearTeam: 'O', defaultRoom: '#o', launcher: 'other.sh' }] }));
      expect(() => applyInstall(plan)).toThrow(/registry changed underneath/i);
      expect(readFileSync(registryPath, 'utf8')).toContain('"other"');
    });

    it('writes NO target-repo files when the registry raced after planning (CAS pre-pass aborts before any write)', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
      const registryPath = join(opts.homeDir, '.heddle', 'projects.json');
      writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ name: 'before', workspaceRoots: [join(opts.homeDir, 'before')], agentIds: ['B'], linearTeam: 'B', defaultRoom: '#b', launcher: 'before.sh' }] }));
      const plan = planInstall(opts);
      // Race: the registry changes between plan and apply.
      writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: [{ name: 'other', workspaceRoots: [join(opts.homeDir, 'other')], agentIds: ['O'], linearTeam: 'O', defaultRoom: '#o', launcher: 'other.sh' }] }));
      const settingsPath = join(opts.dir, '.claude', 'settings.json');
      expect(() => applyInstall(plan)).toThrow(/registry changed underneath/i);
      // The pre-pass aborts before ANY target-repo write — no half-installed repo (settings absent).
      expect(existsSync(settingsPath)).toBe(false);
    });

    it('fails rather than dropping another root\'s key when memtrace-enforce.json changed after planning (CAS)', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
      const enforcePath = join(opts.homeDir, '.heddle', 'memtrace-enforce.json');
      writeFileSync(enforcePath, JSON.stringify({ '/repoA': true }));
      const plan = planInstall(opts);
      // Race: a concurrent init on a different root added its key between plan and apply.
      writeFileSync(enforcePath, JSON.stringify({ '/repoA': true, '/repoC': false }));
      expect(() => applyInstall(plan)).toThrow(/memtrace-enforce changed underneath/i);
      // repoC's key survives — the CAS aborts instead of a last-writer-wins overwrite dropping it.
      expect(readFileSync(enforcePath, 'utf8')).toContain('/repoC');
    });

    it('aborts rather than clobbering a target merge file (settings.json) edited between plan and apply (CAS)', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.dir, '.claude'), { recursive: true });
      const settingsPath = join(opts.dir, '.claude', 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
      const plan = planInstall(opts);
      // Concurrent edit: a user adds an unrelated key to settings.json after planning.
      writeFileSync(settingsPath, JSON.stringify({ hooks: {}, permissions: { allow: ['Read'] } }));
      expect(() => applyInstall(plan)).toThrow(/settings changed underneath/i);
      // The added key survives — the CAS aborts instead of the stale plan overwriting it.
      expect(readFileSync(settingsPath, 'utf8')).toContain('permissions');
    });

    it('aborts rather than clobbering .memtraceignore edited between plan and apply (CAS)', () => {
      const opts = options(tempDir());
      mkdirSync(opts.dir, { recursive: true });
      const ignorePath = join(opts.dir, '.memtraceignore');
      writeFileSync(ignorePath, 'keep-me\n');
      const plan = planInstall(opts);
      // Concurrent edit: a user rewrites .memtraceignore after planning.
      writeFileSync(ignorePath, 'user-edit\n');
      expect(() => applyInstall(plan)).toThrow(/memtraceignore changed underneath/i);
      // The user's edit survives — the CAS aborts instead of the stale plan overwriting it.
      // (renderIgnoreStep guards the drop of `expectedContent`; without it the suite stayed green
      //  while a concurrent edit was silently clobbered — HED-84 review round 8, ledger 668.)
      expect(readFileSync(ignorePath, 'utf8')).toContain('user-edit');
    });

    it('preserves an unrelated oversized JSON integer byte-exact when updating a project', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
      const registryPath = join(opts.homeDir, '.heddle', 'projects.json');
      const target = { name: 'toy', workspaceRoots: [realpathSync.native(opts.dir)], agentIds: ['Z'], linearTeam: 'OLD', defaultRoom: '#toy', launcher: 'old.sh' };
      const future = `{"name":"future","workspaceRoots":["${join(opts.homeDir, 'future')}"],"agentIds":["F"],"linearTeam":"F","defaultRoom":"#f","launcher":"future.sh","futureField":9007199254740993}`;
      const source = `{"schemaVersion":1,"projects":[${JSON.stringify(target)},${future}]}`;
      writeFileSync(registryPath, source);
      applyInstall(planInstall({ ...opts, team: 'NEW' }));
      expect(readFileSync(registryPath, 'utf8').slice(readFileSync(registryPath, 'utf8').indexOf(future))).toBe(`${future}]}`);
    });

    it('preserves the destination mode when replacing a settings file atomically', () => {
      const opts = options(tempDir());
      mkdirSync(join(opts.dir, '.claude'), { recursive: true });
      const settingsPath = join(opts.dir, '.claude', 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
      chmodSync(settingsPath, 0o600);
      applyInstall(planInstall(opts));
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    });
  });
});
