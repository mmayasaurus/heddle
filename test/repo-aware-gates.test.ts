import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { fakeAdapter, useTempResources } from './helpers.js';

const APP_TEXT = ['Spinventory-Rebuild-Official/Rebuild-Project-Root', 'npm run gate', 'expo-router'];

function initRepo(root: string, relativeCwd: string, remote?: string): string {
  mkdirSync(join(root, relativeCwd), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return join(root, relativeCwd);
}

describe('dispatch — repo-aware quality gates', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-repo-aware-gate-');

  async function materializedAgents(cwd: string): Promise<string> {
    const fake = fakeAdapter();
    await dispatch(
      { overrideReason: 'test: materializes the effective quality gate for this repository', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd },
      tempLedger(),
      () => fake.adapter,
    );
    return fake.calls[0].agents!;
  }

  it('uses the heddle core gate for a cwd inside a heddle worktree', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle'), '.worktrees/worker');
    const agents = await materializedAgents(cwd);

    expect(agents).toContain('### repo-heddle-core');
    expect(agents).toContain('npm run typecheck');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
  });

  it('uses the dashboard gate for a cwd inside heddle-dashboard', async () => {
    const cwd = initRepo(join(tempDir(), 'heddle-dashboard'), '.worktrees/worker');
    const agents = await materializedAgents(cwd);

    expect(agents).toContain('### repo-heddle-dashboard');
    expect(agents).toContain('pnpm build');
    expect(agents).toContain('cargo check');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
  });

  it('uses the workspace gate for a Spinventory workspace cwd', async () => {
    const cwd = initRepo(join(tempDir(), 'Spinventory-Rebuild-App-Workspace'), '.worktrees/worker');
    const agents = await materializedAgents(cwd);

    expect(agents).toContain('### repo-workspace');
    expect(agents).toContain('/usr/bin/python3');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
  });

  it('uses the workspace gate when the workspace is identified by its origin remote', async () => {
    const cwd = initRepo(join(tempDir(), 'local-workspace-name'), 'worker', 'git@github.com:maya/Spinventory-Rebuild-Workspace.git');
    const agents = await materializedAgents(cwd);

    expect(agents).toContain('### repo-workspace');
    for (const text of APP_TEXT) expect(agents).not.toContain(text);
  });

  it('fails safe for an unknown repository and reserves app text for the app repository', async () => {
    const unknown = await materializedAgents(initRepo(join(tempDir(), 'unknown-repo'), 'worker'));
    expect(unknown).not.toContain('### quality-gate');
    for (const text of APP_TEXT) expect(unknown).not.toContain(text);

    const app = await materializedAgents(initRepo(join(tempDir(), 'Spinventory-Rebuild-Official', 'Rebuild-Project-Root'), 'worker'));
    expect(app).toContain('### quality-gate');
    for (const text of APP_TEXT) expect(app).toContain(text);
  });
});
