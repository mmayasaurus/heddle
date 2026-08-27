import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyInstall, DISCIPLINE_WIRING, planInstall } from '../src/init-project.js';
import { useTempResources } from './helpers.js';

const WIRED_HOOKS = [
  'agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py',
  'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py',
];

function fixture(base: string) {
  const canonical = join(base, 'canonical');
  const target = join(base, 'target');
  const homeDir = join(base, 'home');
  mkdirSync(join(canonical, 'hooks'), { recursive: true });
  for (const hook of WIRED_HOOKS) writeFileSync(join(canonical, 'hooks', hook), '');
  mkdirSync(target);
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

  it('merges discipline wiring in place while preserving user hooks and groups', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ keep: true, hooks: { PreToolUse: [{ matcher: 'Custom', extra: 'preserve', hooks: [{ type: 'command', command: 'echo custom' }] }, { matcher: 'Bash', keep: true, hooks: [{ type: 'command', command: 'echo custom' }, { type: 'command', command: 'python old/hooks/require-memtrace-first.py deny-recursive-search' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'python old/hooks/require-memtrace-first.py record' }] }] } }));
    applyInstall(planInstall(opts));
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.keep).toBe(true);
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Custom', extra: 'preserve' });
    const bash = settings.hooks.PreToolUse.filter((group: any) => group.matcher === 'Bash');
    expect(bash).toHaveLength(1);
    expect(bash[0].hooks[0].command).toBe('echo custom');
    expect(bash[0].hooks).toHaveLength(3);
    expect(JSON.stringify(settings)).not.toContain('old/require-memtrace-first.py');
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

  it('always writes the per-root memtrace opt-in marker and preserves other roots', () => {
    const opts = options(tempDir());
    applyInstall(planInstall({ ...opts, enforceMemtrace: true }));
    expect(JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))[realpathSync.native(opts.dir)]).toBe(true);
    const off = options(tempDir());
    mkdirSync(join(off.homeDir, '.heddle'), { recursive: true });
    writeFileSync(join(off.homeDir, '.heddle', 'memtrace-enforce.json'), JSON.stringify({ '/other': true }));
    applyInstall(planInstall(off));
    expect(JSON.parse(readFileSync(join(off.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))).toMatchObject({ '/other': true, [realpathSync.native(off.dir)]: false });
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

  it('preserves registration fields and other projects byte-for-byte on a valid rerun', () => {
    const opts = options(tempDir()); mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true });
    const other = { name: 'other', workspaceRoots: [join(opts.homeDir, 'other')], agentIds: ['O'], linearTeam: 'O', defaultRoom: '#o', launcher: 'o.sh' };
    const own = { name: 'toy', workspaceRoots: [realpathSync.native(opts.dir)], agentIds: ['Z', 'Y'], linearTeam: 'NEW', defaultRoom: '#toy', launcher: 'resume-toy.sh' };
    writeFileSync(join(opts.homeDir, '.heddle', 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [other, own] }, null, 2) + '\n');
    const { team, agents, room, launcher, ...rerun } = opts; applyInstall(planInstall(rerun));
    const registry = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8'));
    expect(registry.projects).toEqual([other, own]);
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

  it('uses flag, environment, canonical.json, then default precedence', () => {
    const opts = options(tempDir()); const configCanonical = join(tempDir(), 'config'); mkdirSync(join(configCanonical, 'hooks'), { recursive: true }); for (const hook of WIRED_HOOKS) writeFileSync(join(configCanonical, 'hooks', hook), '');
    const envCanonical = join(tempDir(), 'env'); mkdirSync(join(envCanonical, 'hooks'), { recursive: true }); for (const hook of WIRED_HOOKS) writeFileSync(join(envCanonical, 'hooks', hook), '');
    mkdirSync(join(opts.homeDir, '.heddle'), { recursive: true }); writeFileSync(join(opts.homeDir, '.heddle', 'canonical.json'), JSON.stringify({ canonical: configCanonical }));
    const old = process.env.HEDDLE_CANONICAL; process.env.HEDDLE_CANONICAL = envCanonical;
    const { canonical, ...withoutFlag } = opts;
    try { expect(planInstall(withoutFlag).options.canonical).toBe(realpathSync.native(envCanonical)); expect(planInstall({ ...withoutFlag, canonical: opts.canonical }).options.canonical).toBe(realpathSync.native(opts.canonical)); }
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
});
