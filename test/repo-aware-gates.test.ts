import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, planDispatch } from '../src/dispatch.js';
import { originRepoName, qualityGateForRepository } from '../src/skillpacks.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

/**
 * HED-389: `quality-gate` is the Spinventory APP gate (`npm run gate`, expo-router, `cd` into
 * Rebuild-Project-Root) and the default pack of every editing class, so a heddle worker used to be
 * handed app-checkout instructions. The gate is now resolved per REPOSITORY from the dispatch cwd.
 *
 * A real dispatch cwd is a LINKED worktree — `<repo>/.worktrees/<agent>` on the heddle side, the
 * sibling `Rebuild-Project-Root.<feature>` on the Spinventory side — where `git rev-parse
 * --show-toplevel` is the WORKTREE path, so repository identity must come from the MAIN checkout.
 * These fixtures therefore build real `git worktree add` worktrees: a subdirectory of a plain
 * `git init` repo resolves to the repo root and hides exactly that bug (the first draft's did).
 */
const APP_TEXT = ['Spinventory-Rebuild-Official/Rebuild-Project-Root', 'npm run gate', 'expo-router'];
const NO_GATE = ['worker-role', 'worker-hygiene', 'family-codex'];

// Hermetic git: no operator global/system config (gpgsign, hooksPath, …) and none of the env vars
// through which git ignores cwd — the very leak the code under test must be immune to.
const GIT_ENV = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[name];
  return env;
})();

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

/**
 * A `git init` repository at `root`. The returned cwd is `root/<relativeCwd>` — a plain subdirectory,
 * or (linkedWorktree) a real linked worktree created with `git worktree add`, which may sit outside
 * `root` (`../Rebuild-Project-Root.<feature>` is how the Spinventory fleet lays its worktrees out).
 */
function initRepo(
  root: string, relativeCwd: string, opts: { remote?: string; linkedWorktree?: boolean } = {},
): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  if (opts.remote) git(root, 'remote', 'add', 'origin', opts.remote);
  const cwd = join(root, relativeCwd);
  if (opts.linkedWorktree) {
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init');
    git(root, 'worktree', 'add', '-q', cwd, '-b', 'worker');
  } else {
    mkdirSync(cwd, { recursive: true });
  }
  return cwd;
}

describe('dispatch — repo-aware quality gates (HED-389)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-repo-aware-gate-');

  /**
   * Dispatch the DEFAULT editing class (bulk-mechanical: `[worker-role, quality-gate]` in
   * routing.v0.yaml — the route HED-389 is about, not an explicit skills list) into `cwd`, and
   * return what the worker actually saw (its AGENTS.md) plus what the ledger persisted.
   */
  async function editingDispatch(cwd: string): Promise<{ agents: string; skills: string[]; ledgerSkills: unknown }> {
    const fake = fakeAdapter();
    const ledger = tempLedger();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd }, ledger, () => fake.adapter);
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    return { agents: fake.calls[0].agents!, skills: outcome.skills, ledgerSkills: ledger.recent(1)[0].skills };
  }

  it('hands a heddle worker in a linked worktree the heddle core gate, never the app gate', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-heddle-core');
    expect(agents).toContain('npm run typecheck');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,repo-heddle-core,family-codex');
  });

  it('hands a heddle-dashboard worker in a linked worktree the dashboard gate', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle-dashboard'), '.worktrees/W-hed120', { linkedWorktree: true });
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-heddle-dashboard');
    expect(agents).toContain('pnpm build');
    expect(agents).toContain('cargo check');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-dashboard', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,repo-heddle-dashboard,family-codex');
  });

  it('hands a workspace worker in a linked worktree the workspace gate (no origin needed)', async () => {
    const cwd = initRepo(join(tempDir(), 'Spinventory-Rebuild-App'), '.worktrees/S-hed311', { linkedWorktree: true });
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-workspace');
    expect(agents).toContain('/usr/bin/python3');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-workspace', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,repo-workspace,family-codex');
  });

  it('recognizes a differently-named clone by the EXACT origin repository name — never a substring', async () => {
    const byOrigin = await editingDispatch(initRepo(join(tempDir(), 'local-workspace-name'), 'worker', { remote: 'git@github.com:maya/Spinventory-Rebuild-Workspace.git' }));
    expect(byOrigin.agents).toContain('### repo-workspace');
    expect(byOrigin.agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(byOrigin.agents).not.toContain(text);
    expect(byOrigin.ledgerSkills).toBe('worker-role,worker-hygiene,repo-workspace,family-codex');

    // A renamed dashboard clone, in a linked worktree, identified by origin (round-1 review #7)…
    const renamed = await editingDispatch(initRepo(join(tempDir(), 'heddle-dashboard-old'), '.worktrees/W-hed120', { remote: 'https://github.com/mmayasaurus/heddle-dashboard.git', linkedWorktree: true }));
    expect(renamed.skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-dashboard', 'family-codex']);
    // …but without an origin a renamed clone is unknown: no gate, by design.
    const unnamed = await editingDispatch(initRepo(join(tempDir(), 'heddle-dashboard-old'), '.worktrees/W-hed120', { linkedWorktree: true }));
    expect(unnamed.skills).toEqual(NO_GATE);

    // An origin that merely CONTAINS a known name is not that repository (round-1 review #3).
    const fork = await editingDispatch(initRepo(join(tempDir(), 'local-workspace-name'), 'worker', { remote: 'git@github.com:maya/Spinventory-Rebuild-Workspace-fork.git' }));
    expect(fork.skills).toEqual(NO_GATE);
    expect(fork.agents).not.toContain('### repo-');
  });

  it('keeps the app gate for the app repository — including its sibling-style linked worktrees', async () => {
    // The Spinventory fleet's layout: worktrees are SIBLINGS of the main checkout, not inside it.
    const root = join(tempDir(), 'Spinventory-Rebuild-Official', 'Rebuild-Project-Root');
    const { agents, skills, ledgerSkills } = await editingDispatch(initRepo(root, '../Rebuild-Project-Root.forms', { linkedWorktree: true }));

    expect(agents).toContain('### quality-gate');
    expect(agents).not.toContain('### repo-');
    for (const text of APP_TEXT) expect(agents).toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'quality-gate', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,quality-gate,family-codex');

    // Negative control — the same layout under the wrong parent is NOT the app checkout: the app
    // gate is dropped, which is what proves the case above is the layout rule and not a no-op.
    const other = await editingDispatch(initRepo(join(tempDir(), 'Other-Org', 'Rebuild-Project-Root'), '../Rebuild-Project-Root.forms', { linkedWorktree: true }));
    expect(other.skills).toEqual(NO_GATE);
    for (const text of APP_TEXT) expect(other.agents).not.toContain(text);
  });

  it('fails safe in an unknown repository: no gate at all rather than the app gate', async () => {
    const cwd = initRepo(join(tempDir(), 'unknown-repo'), 'worker');
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### worker-role');
    expect(agents).not.toContain('### quality-gate');
    expect(agents).not.toContain('### repo-');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(NO_GATE);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,family-codex');
  });

  it('follows the cwd, never GIT_DIR / GIT_WORK_TREE in the environment (round-1 review #1)', async () => {
    const base = tempDir();
    const appRoot = join(base, 'Spinventory-Rebuild-Official', 'Rebuild-Project-Root');
    initRepo(appRoot, 'worker');
    const heddleCwd = initRepo(join(base, 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });
    // A git hook exports GIT_DIR; an orchestrator launched from one would inherit it. Point the env
    // at the APP repository and dispatch into the heddle worktree.
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(appRoot, '.git');
    process.env.GIT_WORK_TREE = appRoot;
    try {
      const { agents, skills } = await editingDispatch(heddleCwd);
      expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
      for (const text of APP_TEXT) expect(agents).not.toContain(text);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it('resolves the same gate on the dry-run and in-session paths as on a real dispatch (parity)', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });

    const plan = planDispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound });
    expect(plan.skillsForRefusal).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);

    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'deep-implementation', prompt: 'x', cwd, orchestrator: 'U', issue: 'HED-1', inSession: true },
      ledger, () => fakeAdapter().adapter,
    );
    expect(outcome.refusal?.code).toBe('claude-in-session');
    expect(outcome.skills).toEqual(['worker-role', 'worker-hygiene', 'code-discovery', 'repo-heddle-core', 'family-claude']);
    expect(outcome.refusal?.instruction).toContain('repo-heddle-core');
    expect(outcome.refusal?.instruction).not.toContain('quality-gate');
    expect(ledger.recent(1)[0].skills).toBe('worker-role,worker-hygiene,code-discovery,repo-heddle-core,family-claude');
  });
});

describe('qualityGateForRepository — identity rules (pure)', () => {
  const app = '/x/Spinventory-Rebuild-Official/Rebuild-Project-Root';

  it('drops when the main checkout is unknowable, never keying on the worktree folder (round-1 review #2)', () => {
    expect(qualityGateForRepository(null)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: null, originUrl: null })).toBeNull();
    expect(qualityGateForRepository({ topLevel: app, mainRoot: null, originUrl: null })).toBeNull();
  });

  it('keys on the main checkout, not the worktree top level', () => {
    expect(qualityGateForRepository({ topLevel: '/x/heddle/.worktrees/S-hed389', mainRoot: '/x/heddle', originUrl: null })).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: `${app}.forms`, mainRoot: app, originUrl: null })).toBe('quality-gate');
    expect(qualityGateForRepository({ topLevel: '/x/Spinventory-Rebuild-App.hed191', mainRoot: '/x/Spinventory-Rebuild-App', originUrl: null })).toBe('repo-workspace');
  });

  it('the app checkout keeps its gate whatever origin says; elsewhere folder and origin must agree (round-1 review #3)', () => {
    expect(qualityGateForRepository({ topLevel: app, mainRoot: app, originUrl: 'git@github.com:maya/Spinventory-Rebuild-Workspace.git' })).toBe('quality-gate');
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: 'https://github.com/mmayasaurus/heddle-dashboard.git' })).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: 'https://github.com/mmayasaurus/heddle.git' })).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: '/x/Spinventory-Rebuild-App-2', mainRoot: '/x/Spinventory-Rebuild-App-2', originUrl: null })).toBeNull(); // prefix is not identity
  });

  it('matches origin by exact repository name, in every common URL form', () => {
    expect(originRepoName('https://github.com/mmayasaurus/Spinventory-Rebuild-Workspace.git')).toBe('Spinventory-Rebuild-Workspace');
    expect(originRepoName('git@github.com:maya/heddle')).toBe('heddle');
    expect(originRepoName('ssh://git@github.com/maya/heddle-dashboard.git/')).toBe('heddle-dashboard');
    expect(originRepoName(null)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/clone', mainRoot: '/x/clone', originUrl: 'git@github.com:maya/Spinventory-Rebuild-Workspace-fork.git' })).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/clone', mainRoot: '/x/clone', originUrl: 'git@github.com:maya/Spinventory-V2-Official-App-Rebuild.git' })).toBe('quality-gate');
  });
});
