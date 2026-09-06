import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, planDispatch } from '../src/dispatch.js';
import { builtinPacksDir, loadGateMaps, originRepoName, qualityGateForRepository, type GateMaps } from '../src/skillpacks.js';
import { loadProjectRegistry, projectForAgent, projectForCwd } from '../src/projects.js';
import { parentCheckoutOf } from '../src/worktree.js';
import { fakeAdapter, IDENTITIES, initRepoFixture, useTempResources } from './helpers.js';

/**
 * HED-389: `quality-gate` is the consumer APP gate (`npm run gate`, expo-router, `cd` into
 * Rebuild-Project-Root) and the default pack of every editing class, so a heddle worker used to be
 * handed app-checkout instructions. The gate is now resolved per REPOSITORY from the dispatch cwd.
 *
 * A real dispatch cwd is a LINKED worktree — `<repo>/.worktrees/<agent>` on the heddle side, the
 * sibling `Rebuild-Project-Root.<feature>` on the consumer-project side — where `git rev-parse
 * --show-toplevel` is the WORKTREE path, so repository identity must come from the MAIN checkout.
 * These fixtures therefore build real `git worktree add` worktrees: a subdirectory of a plain
 * `git init` repo resolves to the repo root and hides exactly that bug (the first draft's did).
 */
const APP_TEXT = ['CONSUMER-GATE-MARKER: acme app gate'];
const NO_GATE = ['worker-role', 'worker-hygiene', 'family-codex'];
const REGISTRY_MAPS: GateMaps = {
  app: new Map([['Acme-App-Official\0App-Root', { parent: 'Acme-App-Official', dir: 'App-Root', pack: 'acme-app-gate' }]]),
  byFolderName: new Map([['heddle', 'repo-heddle-core'], ['heddle-dashboard', 'repo-heddle-dashboard'], ['acme-workspace', 'repo-workspace']]),
  byOriginName: new Map([['heddle', 'repo-heddle-core'], ['heddle-dashboard', 'repo-heddle-dashboard'], ['acme-workspace-origin', 'repo-workspace'], ['Acme-App-Rebuild', 'acme-app-gate']]),
};

const initRepo = initRepoFixture;

describe('dispatch — repo-aware quality gates (HED-389)', { timeout: 120_000 /* HED-466: full-suite load starves this git/subprocess suite; root cause HED-459 */ }, () => {
  const { tempDir, tempLedger } = useTempResources('heddle-repo-aware-gate-');
  const savedProjects = process.env.HEDDLE_PROJECTS;
  const savedPacks = process.env.HEDDLE_PACKS;

  beforeEach(() => {
    const root = tempDir();
    const packs = join(root, 'packs');
    const registry = join(root, 'projects.json');
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, 'acme-app-gate.md'), `# Acme app gate\n${APP_TEXT[0]}\n`);
    writeFileSync(registry, JSON.stringify({ schemaVersion: 1, projects: [{
      name: 'Acme', workspaceRoots: [root], agentIds: ['A'], linearTeam: 'ACM', defaultRoom: '#acme', launcher: 'acme.sh',
      gates: {
        app: { parent: 'Acme-App-Official', dir: 'App-Root', pack: 'acme-app-gate' },
        byFolderName: { 'acme-workspace': 'repo-workspace' },
        byOriginName: { 'acme-workspace-origin': 'repo-workspace', 'Acme-App-Rebuild': 'acme-app-gate' },
      },
    }] }));
    process.env.HEDDLE_PROJECTS = registry;
    process.env.HEDDLE_PACKS = packs;
  });

  afterEach(() => {
    if (savedProjects === undefined) delete process.env.HEDDLE_PROJECTS; else process.env.HEDDLE_PROJECTS = savedProjects;
    if (savedPacks === undefined) delete process.env.HEDDLE_PACKS; else process.env.HEDDLE_PACKS = savedPacks;
  });

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
    const cwd = initRepo(join(tempDir(), 'acme-workspace'), '.worktrees/S-hed311', { linkedWorktree: true });
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-workspace');
    expect(agents).toContain('/usr/bin/python3');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-workspace', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,repo-workspace,family-codex');
  });

  it('recognizes a differently-named clone by the EXACT origin repository name — never a substring', async () => {
    const byOrigin = await editingDispatch(initRepo(join(tempDir(), 'local-workspace-name'), 'worker', { remote: 'git@github.com:example-org/acme-workspace-origin.git' }));
    expect(byOrigin.agents).toContain('### repo-workspace');
    expect(byOrigin.agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(byOrigin.agents).not.toContain(text);
    expect(byOrigin.ledgerSkills).toBe('worker-role,worker-hygiene,repo-workspace,family-codex');

    // A renamed dashboard clone, in a linked worktree, identified by origin (round-1 review #7)…
    const renamed = await editingDispatch(initRepo(join(tempDir(), 'heddle-dashboard-old'), '.worktrees/W-hed120', { remote: 'https://github.com/example-org/heddle-dashboard.git', linkedWorktree: true }));
    expect(renamed.skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-dashboard', 'family-codex']);
    // …but without an origin a renamed clone is unknown: no gate, by design.
    const unnamed = await editingDispatch(initRepo(join(tempDir(), 'heddle-dashboard-old'), '.worktrees/W-hed120', { linkedWorktree: true }));
    expect(unnamed.skills).toEqual(NO_GATE);

    // An origin that merely CONTAINS a known name is not that repository (round-1 review #3).
    const fork = await editingDispatch(initRepo(join(tempDir(), 'local-workspace-name'), 'worker', { remote: 'git@github.com:example-org/acme-workspace-origin-fork.git' }));
    expect(fork.skills).toEqual(NO_GATE);
    expect(fork.agents).not.toContain('### repo-');
  });

  it('keeps the app gate for the app repository — including its sibling-style linked worktrees', async () => {
    // The consumer project's layout: worktrees are SIBLINGS of the main checkout, not inside it.
    const root = join(tempDir(), 'Acme-App-Official', 'App-Root');
    const { agents, skills, ledgerSkills } = await editingDispatch(initRepo(root, '../App-Root.forms', { linkedWorktree: true }));

    expect(agents).toContain('### acme-app-gate');
    expect(agents).not.toContain('### repo-');
    for (const text of APP_TEXT) expect(agents).toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'acme-app-gate', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,acme-app-gate,family-codex');

    // Negative control — the same layout under the wrong parent is NOT the app checkout: the app
    // gate is dropped, which is what proves the case above is the layout rule and not a no-op.
    const other = await editingDispatch(initRepo(join(tempDir(), 'Other-Org', 'App-Root'), '../App-Root.forms', { linkedWorktree: true }));
    expect(other.skills).toEqual(NO_GATE);
    for (const text of APP_TEXT) expect(other.agents).not.toContain(text);
  });

  it('keeps a CONSUMER-shadowed quality-gate pack (HEDDLE_PACKS) — only the built-in app gate is repository-resolved', async () => {
    const packs = join(tempDir(), 'consumer-packs');
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, 'quality-gate.md'), '# Consumer gate\nCONSUMER-GATE-MARKER: run `make verify`.\n');
    const saved = process.env.HEDDLE_PACKS;
    process.env.HEDDLE_PACKS = packs;
    try {
      const { agents, skills } = await editingDispatch(initRepo(join(tempDir(), 'unknown-repo'), 'worker'));
      expect(skills).toEqual(['worker-role', 'worker-hygiene', 'quality-gate', 'family-codex']);
      expect(agents).toContain('### quality-gate');
      expect(agents).toContain('CONSUMER-GATE-MARKER');
      for (const text of APP_TEXT) expect(agents).not.toContain(text);

      // A HEDDLE_PACKS entry that is heddle's OWN pack again — a byte-identical copy of the built-in
      // (another checkout's skills/), with a trailing slash — is NOT a consumer shadow: it is still
      // the app gate and is still resolved (round-3 review #1).
      const copy = join(tempDir(), 'other-heddle-checkout', 'skills');
      mkdirSync(copy, { recursive: true });
      copyFileSync(join(builtinPacksDir(), 'quality-gate.md'), join(copy, 'quality-gate.md'));
      process.env.HEDDLE_PACKS = `${copy}/`;
      const heddle = await editingDispatch(initRepo(join(tempDir(), 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true }));
      expect(heddle.skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
      for (const text of APP_TEXT) expect(heddle.agents).not.toContain(text);
    } finally {
      if (saved === undefined) delete process.env.HEDDLE_PACKS; else process.env.HEDDLE_PACKS = saved;
    }
  });

  it('does not treat HOME/.heddle/packs as a consumer shadow (regression PR#112 — user pack scope)', async () => {
    const home = join(tempDir(), 'home');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    const saved = process.env.HEDDLE_PACKS;
    mkdirSync(join(home, '.heddle', 'packs'), { recursive: true });
    writeFileSync(join(home, '.heddle', 'packs', 'quality-gate.md'), '# User gate\nUSER-GATE-MARKER\n');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.HEDDLE_PACKS;
    try {
      const cwd = initRepo(join(tempDir(), 'heddle'), '.worktrees/Y', { linkedWorktree: true });
      const heddle = await editingDispatch(cwd);
      expect(heddle.skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
      const unknown = await editingDispatch(initRepo(join(tempDir(), 'unknown-repo'), 'worker'));
      expect(unknown.skills).toEqual(NO_GATE);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
      if (saved === undefined) delete process.env.HEDDLE_PACKS; else process.env.HEDDLE_PACKS = saved;
    }
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
    const appRoot = join(base, 'Acme-App-Official', 'App-Root');
    initRepo(appRoot, 'worker');
    const heddleCwd = initRepo(join(base, 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });
    // A git hook exports GIT_DIR; an orchestrator launched from one would inherit it. Point the env
    // at the APP repository and dispatch into the heddle worktree.
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.GIT_DIR = join(appRoot, '.git');
    process.env.GIT_WORK_TREE = appRoot;
    try {
      const { agents, skills } = await editingDispatch(heddleCwd);
      expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
      for (const text of APP_TEXT) expect(agents).not.toContain(text);

      // The config-injection channel (round-2 review #1): plant an app `origin` on an UNKNOWN repo.
      delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url';
      process.env.GIT_CONFIG_VALUE_0 = 'git@github.com:example-org/Acme-App-Rebuild.git';
      const injected = await editingDispatch(initRepo(join(base, 'unknown-repo'), 'worker'));
      expect(injected.skills).toEqual(NO_GATE);
      for (const text of APP_TEXT) expect(injected.agents).not.toContain(text);

      // Discovery limits (codex P2 / round-3 #3): a ceiling below the checkout would stop git before
      // the root — dropping the gate AND switching off linked-worktree confinement.
      delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
      process.env.GIT_CEILING_DIRECTORIES = base;
      process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '0';
      const ceiled = await editingDispatch(heddleCwd);
      expect(ceiled.skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-core', 'family-codex']);
      expect(parentCheckoutOf(heddleCwd)?.parentRoot).toBeTruthy();
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

  it('applies the review-class pack UNION on the dry-run path exactly as on the real run (round-2 review #2)', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle'), '.worktrees/S-hed389', { linkedWorktree: true });
    // A review class with an explicit skills list: the class packs (the find-only mandate) are
    // unioned in, and the requested app gate resolves to the repo gate — on BOTH paths.
    const expected = ['worker-role', 'worker-hygiene', 'adversarial-review', 'repo-heddle-core', 'family-cursor'];
    const plan = planDispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', skills: ['quality-gate'], prompt: 'x', cwd, identity: IDENTITIES.unbound });
    expect(plan.skillsForRefusal).toEqual(expected);

    const fake = fakeAdapter();
    const ledger = tempLedger();
    const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', skills: ['quality-gate'], prompt: 'x', cwd, identity: IDENTITIES.unbound }, ledger, () => fake.adapter);
    expect(outcome.skills).toEqual(expected);
    expect(fake.calls[0].agents).toContain('### adversarial-review');
    expect(fake.calls[0].agents).toContain('### repo-heddle-core');
    // A review class auto-assesses, which appends its own ledger row after the dispatch's — find ours.
    const row = ledger.recent(5).find((r) => r.task_class === 'adversarial-review');
    expect(row?.skills).toBe(expected.join(','));
  });
});

describe('qualityGateForRepository — identity rules (pure)', () => {
  const app = '/x/Acme-App-Official/App-Root';

  it('drops when the main checkout is unknowable, never keying on the worktree folder (round-1 review #2)', () => {
    expect(qualityGateForRepository(null, REGISTRY_MAPS)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: null, originUrl: null }, REGISTRY_MAPS)).toBeNull();
    expect(qualityGateForRepository({ topLevel: app, mainRoot: null, originUrl: null }, REGISTRY_MAPS)).toBeNull();
  });

  it('keys on the main checkout, not the worktree top level', () => {
    expect(qualityGateForRepository({ topLevel: '/x/heddle/.worktrees/S-hed389', mainRoot: '/x/heddle', originUrl: null }, REGISTRY_MAPS)).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: `${app}.forms`, mainRoot: app, originUrl: null }, REGISTRY_MAPS)).toBe('acme-app-gate');
    expect(qualityGateForRepository({ topLevel: '/x/acme-workspace.hed191', mainRoot: '/x/acme-workspace', originUrl: null }, REGISTRY_MAPS)).toBe('repo-workspace');
  });

  it('the app checkout keeps its gate whatever origin says; elsewhere folder and origin must agree (round-1 review #3)', () => {
    expect(qualityGateForRepository({ topLevel: app, mainRoot: app, originUrl: 'git@github.com:example-org/acme-workspace-origin.git' }, REGISTRY_MAPS)).toBe('acme-app-gate');
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: 'https://github.com/example-org/heddle-dashboard.git' }, REGISTRY_MAPS)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: 'https://github.com/example-org/heddle.git' }, REGISTRY_MAPS)).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: '/x/acme-workspace-2', mainRoot: '/x/acme-workspace-2', originUrl: null }, REGISTRY_MAPS)).toBeNull(); // prefix is not identity
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: 'git@github.com:someone/other-project.git' }, REGISTRY_MAPS)).toBeNull();
  });

  it('matches origin by exact repository name, in every common URL form', () => {
    expect(originRepoName('https://github.com/example-org/acme-workspace-origin.git')).toBe('acme-workspace-origin');
    expect(originRepoName('git@github.com:example-org/heddle')).toBe('heddle');
    expect(originRepoName('ssh://git@github.com/example-org/heddle-dashboard.git/')).toBe('heddle-dashboard');
    expect(originRepoName(null)).toBeNull();
    // A `/` inside a query or fragment is not a path segment (round-2 review #3).
    expect(originRepoName('https://example.invalid/unrelated.git?redirect=/Acme-App-Rebuild.git')).toBe('unrelated');
    expect(originRepoName('https://github.com/example-org/heddle.git#/acme-workspace-origin')).toBe('heddle');
    expect(qualityGateForRepository({ topLevel: '/x/clone', mainRoot: '/x/clone', originUrl: 'https://example.invalid/unrelated.git?redirect=/Acme-App-Rebuild.git' }, REGISTRY_MAPS)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/clone', mainRoot: '/x/clone', originUrl: 'git@github.com:example-org/acme-workspace-origin-fork.git' }, REGISTRY_MAPS)).toBeNull();
    expect(qualityGateForRepository({ topLevel: '/x/clone', mainRoot: '/x/clone', originUrl: 'git@github.com:example-org/Acme-App-Rebuild.git' }, REGISTRY_MAPS)).toBe('acme-app-gate');
  });
});

describe('registry-backed gate maps', () => {
  const { tempDir } = useTempResources('heddle-gate-registry-');
  const project = (name: string, gates?: any) => ({
    name, workspaceRoots: ['/tmp/acme'], agentIds: [name], linearTeam: 'ACM', defaultRoom: '#acme', launcher: 'acme.sh', gates,
  });

  it('keeps built-ins on no registry or invalid JSON and warns once for the invalid file', () => {
    const missing = join(tempDir(), 'missing.json');
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: null }, loadGateMaps(missing))).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: '/x/acme-workspace', mainRoot: '/x/acme-workspace', originUrl: null }, loadGateMaps(missing))).toBeNull();
    const invalid = join(tempDir(), 'invalid.json'); writeFileSync(invalid, '{');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: null }, loadGateMaps(invalid))).toBe('repo-heddle-core');
    expect(stderr).toHaveBeenCalledTimes(1); expect(String(stderr.mock.calls[0][0])).toContain(invalid); stderr.mockRestore();
  });

  it('keeps built-ins and drops cross-project collisions while malformed gates do not break projects', () => {
    const path = join(tempDir(), 'projects.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, projects: [
      project('first', { byFolderName: { heddle: 'repo-workspace', contested: 'repo-workspace' } }),
      project('second', { byFolderName: { heddle: 'quality-gate', contested: 'quality-gate' } }),
      project('bad', { byFolderName: { bad: 1 } }),
    ] }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const maps = loadGateMaps(path);
    expect(qualityGateForRepository({ topLevel: '/x/heddle', mainRoot: '/x/heddle', originUrl: null }, maps)).toBe('repo-heddle-core');
    expect(qualityGateForRepository({ topLevel: '/x/contested', mainRoot: '/x/contested', originUrl: null }, maps)).toBeNull();
    expect(stderr).toHaveBeenCalledTimes(4);
    expect(String(stderr.mock.calls[0][0])).toContain('first');
    expect(String(stderr.mock.calls[1][0])).toContain('second');
    stderr.mockRestore();
  });

  it('keeps malformed gates loaded from disk from breaking project lookups', () => {
    const path = join(tempDir(), 'malformed-gates.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, projects: [project('bad', { byFolderName: { bad: 1 } })] }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const registry = loadProjectRegistry(path);
    expect(projectForAgent(registry, 'bad')?.name).toBe('bad');
    expect(projectForCwd(registry, '/tmp/acme/x')?.name).toBe('bad');
    loadGateMaps(path);
    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it('never returns a registry pack on a miss', () => {
    for (const repo of [null, { topLevel: '/x/unknown', mainRoot: '/x/unknown', originUrl: null }, { topLevel: '/x/acme', mainRoot: null, originUrl: null }]) {
      expect(qualityGateForRepository(repo, { app: new Map(), byFolderName: new Map(), byOriginName: new Map() })).toBeNull();
    }
  });
});
