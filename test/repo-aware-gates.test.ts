import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { fakeAdapter, useTempResources } from './helpers.js';

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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
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
    const { agents, skills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-heddle-dashboard');
    expect(agents).toContain('pnpm build');
    expect(agents).toContain('cargo check');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-heddle-dashboard', 'family-codex']);
  });

  it('hands a workspace worker in a linked worktree the workspace gate (no origin needed)', async () => {
    const cwd = initRepo(join(tempDir(), 'Spinventory-Rebuild-App'), '.worktrees/S-hed311', { linkedWorktree: true });
    const { agents, skills } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-workspace');
    expect(agents).toContain('/usr/bin/python3');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'repo-workspace', 'family-codex']);
  });

  it('recognizes the workspace by its origin remote when the checkout is named differently', async () => {
    const cwd = initRepo(join(tempDir(), 'local-workspace-name'), 'worker', { remote: 'git@github.com:maya/Spinventory-Rebuild-Workspace.git' });
    const { agents } = await editingDispatch(cwd);

    expect(agents).toContain('### repo-workspace');
    expect(agents).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
  });

  it('keeps the app gate for the app repository — including its sibling-style linked worktrees', async () => {
    // The Spinventory fleet's layout: worktrees are SIBLINGS of the main checkout, not inside it.
    const root = join(tempDir(), 'Spinventory-Rebuild-Official', 'Rebuild-Project-Root');
    const cwd = initRepo(root, '../Rebuild-Project-Root.forms', { linkedWorktree: true });
    const { agents, skills } = await editingDispatch(cwd);

    expect(agents).toContain('### quality-gate');
    for (const text of APP_TEXT) expect(agents).toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'quality-gate', 'family-codex']);
  });

  it('fails safe in an unknown repository: no gate at all rather than the app gate', async () => {
    const cwd = initRepo(join(tempDir(), 'unknown-repo'), 'worker');
    const { agents, skills, ledgerSkills } = await editingDispatch(cwd);

    expect(agents).toContain('### worker-role');
    expect(agents).not.toContain('### quality-gate');
    expect(agents).not.toContain('### repo-');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
    expect(skills).toEqual(['worker-role', 'worker-hygiene', 'family-codex']);
    expect(ledgerSkills).toBe('worker-role,worker-hygiene,family-codex');
  });
});
