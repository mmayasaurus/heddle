import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAccountRegistry } from '../src/accounts.js';
import { runAccountsAdd } from '../src/wizard/accounts-add.js';
import { ScriptedPrompter } from '../src/wizard/prompt.js';
import type { CliRunner } from '../src/wizard/cli-runner.js';
import { useTempResources } from './helpers.js';

const marker = 'fakefakefakefake';
const fakeRunner: CliRunner = {
  login: () => undefined,
  status: () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: marker, exitCode: 0, timedOut: false }),
};

describe('accounts add wizard', () => {
  const { tempDir } = useTempResources('heddle-accounts-add-test-');

  it('records one Claude subscription account without exposing a vendor secret', async () => {
    const path = join(tempDir(), 'claude.json');
    const transcript: string[] = [];
    const summary = await runAccountsAdd({ provider: 'claude', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'paid', 'T2', false, false]), runner: fakeRunner,
      now: () => new Date('2026-09-13T00:00:00.000Z'), report: (line) => transcript.push(line),
    });
    expect(summary).toEqual({ added: ['claude-1'], failed: [], skipped: [] });
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      id: 'claude-1', provider: 'claude', billingClass: 'subscription-quota', tier: 'T2', loggedIn: true,
    });
    expect(`${transcript.join('\n')}\n${readFileSync(path, 'utf8')}`).not.toContain(marker);
  });

  it('persists each additional account before continuing the provider loop', async () => {
    const path = join(tempDir(), 'two.json');
    await runAccountsAdd({ provider: 'claude', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'first', 'paid', 'T1', true, 'second', 'paid', 'T2', false, false]), runner: fakeRunner,
    });
    const accounts = loadAccountRegistry(path).accounts;
    expect(accounts.map((account) => account.id)).toEqual(['first', 'second']);
    expect(new Set(accounts.map((account) => account.configDir)).size).toBe(2);
  });

  it('writes a valid empty v2 registry when all providers are declined', async () => {
    const path = join(tempDir(), 'empty.json');
    const summary = await runAccountsAdd({ registryPath: path }, {
      prompter: new ScriptedPrompter([false, false, false, false]), runner: fakeRunner,
    });
    expect(summary).toEqual({ added: [], failed: [], skipped: ['claude', 'codex', 'cursor'] });
    expect(existsSync(path)).toBe(true);
    expect(loadAccountRegistry(path)).toEqual({ schemaVersion: 2, accounts: [] });
  });
});
