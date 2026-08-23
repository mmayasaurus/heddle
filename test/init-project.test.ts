import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstall, planInstall } from '../src/init-project.js';
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

describe('init-project', () => {
  const { tempDir } = useTempResources('heddle-init-project-test-');

  it('installs discipline files and registers a fresh project', () => {
    const opts = options(tempDir());
    const plan = planInstall(opts);
    expect(plan.steps.filter((step) => step.action === 'create').map((step) => step.step)).toEqual(expect.arrayContaining([
      'settings', 'rule:pr-review-sweep.md', 'rule:pr-ownership.md', 'rule:worktree-discipline.md', 'mcp', 'memtraceignore', 'heddle-gate', 'registry',
    ]));
    applyInstall(plan);
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    const commands = Object.values(settings.hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks.map((hook: any) => hook.command)));
    expect(commands).toHaveLength(12);
    expect(commands.every((command: string) => command.includes(opts.canonical))).toBe(true);
    const registry = JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'projects.json'), 'utf8'));
    expect(registry.projects[0]).toMatchObject({ name: 'toy', workspaceRoots: [realpathSync.native(opts.dir)] });
  });

  it('is byte-identical on a second run', () => {
    const opts = options(tempDir());
    applyInstall(planInstall(opts));
    const files = [join(opts.dir, '.claude', 'settings.json'), join(opts.dir, '.claude', 'rules', 'pr-review-sweep.md'), join(opts.dir, '.claude', 'rules', 'pr-ownership.md'), join(opts.dir, '.claude', 'rules', 'worktree-discipline.md'), join(opts.dir, '.mcp.json'), join(opts.dir, '.memtraceignore'), join(opts.dir, '.claude', 'commands', 'heddle-gate.md'), join(opts.homeDir, '.heddle', 'projects.json')];
    const hashes = files.map(sha);
    expect(planInstall(opts).steps.every((step) => step.action === 'ok')).toBe(true);
    applyInstall(planInstall(opts));
    expect(files.map(sha)).toEqual(hashes);
  });

  it('does not write during dry-run planning', () => {
    const opts = { ...options(tempDir()), dryRun: true };
    const before = readdirSync(opts.dir);
    const plan = planInstall(opts);
    expect(readdirSync(opts.dir)).toEqual(before);
    expect(plan.steps.some((step) => step.action === 'would-create')).toBe(true);
  });

  it('preserves unrelated hooks and replaces stale discipline wiring', () => {
    const opts = options(tempDir());
    mkdirSync(join(opts.dir, '.claude'));
    writeFileSync(join(opts.dir, '.claude', 'settings.json'), JSON.stringify({ keep: true, hooks: { PreToolUse: [{ matcher: 'Custom', hooks: [{ type: 'command', command: 'echo custom' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'python old/require-memtrace-first.py record' }] }] } }));
    applyInstall(planInstall(opts));
    const settings = JSON.parse(readFileSync(join(opts.dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.keep).toBe(true);
    expect(settings.hooks.PreToolUse.some((group: any) => group.matcher === 'Custom')).toBe(true);
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

  it('writes the per-root memtrace enforcement flag only when requested', () => {
    const opts = options(tempDir());
    applyInstall(planInstall({ ...opts, enforceMemtrace: true }));
    expect(JSON.parse(readFileSync(join(opts.homeDir, '.heddle', 'memtrace-enforce.json'), 'utf8'))[realpathSync.native(opts.dir)]).toBe(true);
    const off = options(tempDir()); applyInstall(planInstall(off));
    expect(existsSync(join(off.homeDir, '.heddle', 'memtrace-enforce.json'))).toBe(false);
  });
});
