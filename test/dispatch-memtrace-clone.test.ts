import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { planDispatch, summarizePlan } from '../src/dispatcher/plan.js';
import { loadRouting } from '../src/routing.js';
import { fakeAdapter, hermeticGit, IDENTITIES, useTempResources } from './helpers.js';

const COMMIT = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init'];
const REFUSAL = 'memtrace-standalone-clone';

describe('dispatch into a standalone clone of a memtrace-indexed repository (HED-723)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-memtrace-clone-test-');
  const { unbound } = IDENTITIES;
  // A few tests write manifests where the code reads them, ~/.memtrace/workspaces. test/setup.ts points
  // HOME at an empty temp dir; this suite refuses to run at all if that ever stops being true, so it can
  // never write into (or clean up) an operator's real memtrace store.
  const homeIsTemp = resolve(homedir()).startsWith(resolve(tmpdir()) + sep);
  const workspacesDir = join(homedir(), '.memtrace', 'workspaces');
  beforeAll(() => {
    if (!homeIsTemp) throw new Error(`HOME (${homedir()}) is not under ${tmpdir()}: refusing to touch its ~/.memtrace`);
  });
  afterEach(() => { if (homeIsTemp) rmSync(workspacesDir, { recursive: true, force: true }); });

  function repo(dir: string, remote?: string): string {
    mkdirSync(dir, { recursive: true });
    hermeticGit(dir, 'init', '-q');
    hermeticGit(dir, ...COMMIT);
    if (remote) hermeticGit(dir, 'remote', 'add', 'origin', remote);
    return dir;
  }

  /**
   * `member` is a checkout the memtrace workspace indexes, `worktree` a linked SIBLING worktree of it
   * (the consumer-fleet layout, where a path-prefix test would call the worktree a stranger), and
   * `clone` a `git clone` of that worktree — the review-clone shape that built the private stores.
   * `memberAlias` names `member` through the unresolved temp path (a symlink on macOS).
   */
  function fixture(): { member: string; memberAlias: string; worktree: string; clone: string } {
    const alias = tempDir();
    const base = realpathSync(alias);
    const member = repo(join(base, 'Project-Root'));
    const worktree = join(base, 'Project-Root.feature');
    hermeticGit(member, 'worktree', 'add', '-q', worktree, '-b', 'feature');
    const clone = join(base, 'review-clone');
    hermeticGit(base, 'clone', '-q', worktree, clone);
    return { member, memberAlias: join(alias, 'Project-Root'), worktree, clone };
  }

  it('refuses a memtrace-carrying dispatch into a clone of an indexed repository before any worker is spawned', async () => {
    const { member, memberAlias, clone } = fixture();
    const fake = fakeAdapter();
    const ledger = tempLedger();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: clone, identity: unbound, memtraceWorkspaceRoots: [memberAlias] },
      ledger, () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(outcome.refusal?.reason).toContain(clone);
    expect(outcome.refusal?.reason).toContain(member);
    expect(outcome.refusal?.instruction).toContain('worktree');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0].refusal).toBe(REFUSAL);
  });

  it('refuses the review-clone case: an adversarial-review, which carries memtrace by class default', async () => {
    const { member, clone } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd: clone, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a second copy that shares the indexed repository\'s remote, whatever the URL spelling', async () => {
    const base = realpathSync(tempDir());
    const member = repo(join(base, 'Project-Root'), 'https://github.com/example/project.git');
    const copy = repo(join(base, 'second-copy'), 'git@GitHub.com:example/project');
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: copy, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a clone of a clone: the origin chain still ends at the indexed repository', async () => {
    const { member, clone } = fixture();
    const second = join(realpathSync(tempDir()), 'clone-of-clone');
    hermeticGit(clone, 'clone', '-q', clone, second);
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: second, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(outcome.refusal?.reason).toContain(member);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a clone whose origin is a file:// URL of the indexed repository', async () => {
    const { member } = fixture();
    const viaFileUrl = join(realpathSync(tempDir()), 'file-url-clone');
    hermeticGit(member, 'clone', '-q', pathToFileURL(member).href, viaFileUrl);
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: viaFileUrl, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(fake.calls).toHaveLength(0);
  });

  it('runs in the main checkout when the workspace lists one of its linked worktrees as the member', async () => {
    const base = realpathSync(tempDir());
    const main = repo(join(base, 'Project-Root'), 'https://github.com/example/project.git');
    const listedWorktree = join(base, 'Project-Root.listed');
    hermeticGit(main, 'worktree', 'add', '-q', listedWorktree, '-b', 'listed');
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: main, identity: unbound, memtraceWorkspaceRoots: [listedWorktree] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses when only the class fallback would run memtrace in the clone', () => {
    const { member, clone } = fixture();
    const routingPath = join(tempDir(), 'routing.yaml');
    const table = (fallbackMcp: string): ReturnType<typeof loadRouting> => {
      writeFileSync(routingPath, `version: 0
policy: {structural_caps: {max_children_per_orchestrator: 8, in_flight_stale_after_ms: 10800000}}
providers:
  glm: {auth: zai-coding-plan-subscription, execution: headless, models: [glm-5.3]}
  codex: {auth: chatgpt-subscription, execution: headless, models: [gpt-5.6-luna]}
task_classes:
  discovery-on-fallback:
    provider: glm
    model: glm-5.3
    mcp: []
    fallback: {provider: codex, model: gpt-5.6-luna, mcp: ${fallbackMcp}}
    read_only: false
    edits_code: false
`);
      return loadRouting(routingPath);
    };
    const req = { taskClass: 'discovery-on-fallback', prompt: 'x', cwd: clone, memtraceWorkspaceRoots: [member] };

    expect(planDispatch(req, table('[memtrace]')).memtraceCloneRefusal).toContain(clone);
    expect(planDispatch(req, table('[]')).memtraceCloneRefusal).toBeUndefined();
  });

  it('runs in a linked sibling worktree of the indexed repository', async () => {
    const { memberAlias, worktree } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: worktree, identity: unbound, memtraceWorkspaceRoots: [memberAlias] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.cwd).toBe(worktree);
  });

  it('runs a codex worker in the clone when the dispatch attaches no memtrace (codex/claude route: no cursor)', async () => {
    const { member, clone } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'implementation', mcp: [], prompt: 'x', cwd: clone, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.cwd).toBe(clone);
  });

  it('refuses a cursor worker in the clone even with mcp: [], before any worker is spawned', async () => {
    const { member, clone } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'second-opinion', mcp: [], prompt: 'x', cwd: clone, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(outcome.refusal?.instruction).toContain('cursor');
    expect(fake.calls).toHaveLength(0);
  });

  it('plans a cursor worker in a linked worktree of the indexed repository without the refusal', () => {
    const { member, worktree } = fixture();

    const plan = planDispatch({ taskClass: 'second-opinion', mcp: [], prompt: 'x', cwd: worktree, memtraceWorkspaceRoots: [member] });

    expect(plan.target.provider).toBe('cursor');
    expect(plan.memtraceCloneRefusal).toBeUndefined();
  });

  it('runs in a repository that is unrelated to every indexed one', async () => {
    const { member } = fixture();
    const stranger = repo(join(realpathSync(tempDir()), 'other-project'), 'https://github.com/example/other.git');
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: stranger, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('runs in a scratch directory outside any repository', async () => {
    const { member } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('runs in the clone when no memtrace workspace is known (nothing to compare against)', async () => {
    const { clone } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: clone, identity: unbound },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('reads the indexed repositories from the memtrace workspace manifests when none are injected', async () => {
    const { member, clone } = fixture();
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(join(workspacesDir, 'fleet.toml'), [
      'schema_version = 1', 'name = "fleet"', '',
      '[[members]]', `path = ${JSON.stringify(member)}`, 'added_at = "2026-09-15T23:06:12+00:00"', '',
    ].join('\n'));
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: clone, identity: unbound },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe(REFUSAL);
    expect(fake.calls).toHaveLength(0);
  });

  it('skips an unreadable manifest and still honours the readable ones', async () => {
    const { readMemtraceWorkspaceRoots } = await import('../src/memtrace-workspace.js');
    const { member } = fixture();
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(join(workspacesDir, 'broken.toml'), 'this is = = not toml [[');
    writeFileSync(join(workspacesDir, 'no-members.toml'), 'name = "empty"\n');
    writeFileSync(join(workspacesDir, 'fleet.toml'), `[[members]]\npath = ${JSON.stringify(member)}\n`);
    writeFileSync(join(workspacesDir, 'notes.txt'), `[[members]]\npath = "/not/a/manifest"\n`);

    expect(readMemtraceWorkspaceRoots()).toEqual([member]);
  });

  it('knows no indexed repositories when memtrace has no workspace directory', async () => {
    const { readMemtraceWorkspaceRoots } = await import('../src/memtrace-workspace.js');

    expect(readMemtraceWorkspaceRoots()).toEqual([]);
  });

  it('previews the same refusal the dispatch makes', () => {
    const { member, clone } = fixture();

    const summary = summarizePlan(planDispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: clone, memtraceWorkspaceRoots: [member] }));

    expect((summary.refusal as { code?: string } | null)?.code).toBe(REFUSAL);
    expect(summary.would_run).toBeNull();
  });

  it('leaves an in-session dispatch alone: it spawns no worker, so nothing attaches memtrace in the clone', async () => {
    const { member, clone } = fixture();
    const fake = fakeAdapter();

    const outcome = await dispatch(
      { taskClass: 'deep-implementation', inSession: true, prompt: 'x', cwd: clone, identity: unbound, memtraceWorkspaceRoots: [member] },
      tempLedger(), () => fake.adapter,
    );

    expect(outcome.refusal?.code).toBe('claude-in-session');
    expect(fake.calls).toHaveLength(0);
  });
});
