import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeMetersPolicy, metersStep } from '../../src/wizard/meters-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

describe('metersStep', () => {
  const { track } = useTempResources('heddle-meters-step-test-');

  function homeWithAccounts(accounts: unknown): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'heddle-meters-step-test-'));
    track(homeDir);
    const heddleDir = join(homeDir, '.heddle');
    mkdirSync(heddleDir, { recursive: true });
    writeFileSync(join(heddleDir, 'accounts.json'), JSON.stringify(accounts));
    return homeDir;
  }

  function context(homeDir: string): WizardContext {
    return { homeDir, now: () => new Date(0), results: new Map() };
  }

  function io(answers: unknown[], captured: string[]): WizardIO {
    return { prompter: new ScriptedPrompter(answers), report: (line) => captured.push(line) };
  }

  it('explains session-start blanks and records each account choice', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [
      { id: 'claude-one', configDir: null },
      { id: 'claude-two', configDir: null },
    ] });
    const captured: string[] = [];

    const result = await metersStep.run(context(homeDir), io([true, false], captured));

    expect(captured.join('\n')).toMatch(/blank|first turn|self-heal/i);
    expect(result).toMatchObject({ id: 'meters', status: 'done', summary: 'usage meters enabled for 1 of 2 account(s)' });
    expect(result.detail).toBe('claude-one (claude): on\nclaude-two (claude): off');
    // The step owns its write: the meters policy lands atomically at ~/.heddle/policy/meters.json.
    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'policy', 'meters.json'), 'utf8'))).toEqual({
      version: 1, accounts: { 'claude-one': { meters: true }, 'claude-two': { meters: false } },
    });
  });

  it('skips an empty registry without prompting', async () => {
    const captured: string[] = [];
    const result = await metersStep.run(context(homeWithAccounts({ schemaVersion: 2, claude: [] })), io([], captured));

    expect(result).toEqual({ id: 'meters', status: 'skipped', summary: 'no accounts to configure' });
    expect(captured).toContain('no accounts to configure meters for');
  });

  it('reports a corrupt registry without throwing', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [] });
    writeFileSync(join(homeDir, '.heddle', 'accounts.json'), '{ not json');

    await expect(metersStep.run(context(homeDir), io([], []))).resolves.toEqual({
      id: 'meters', status: 'failed', summary: 'could not read the account registry',
    });
  });

  it('prompts only for meterable (native Claude) accounts — skips codex and env-repoint', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2,
      claude: [
        { id: 'native-claude', configDir: null },
        { id: 'glm-repoint', configDir: null, envRepoint: { baseUrl: 'https://glm.example', authTokenRef: 'GLM_TOKEN', service: 'glm' } },
      ],
      codex: [{ id: 'codex-1', codexHome: null }],
    });
    const captured: string[] = [];

    // One scripted answer: a filter leak (codex-1 or the env-repoint claude) would prompt again and
    // change the "of N" count / detail below.
    const result = await metersStep.run(context(homeDir), io([true], captured));

    expect(result).toMatchObject({ id: 'meters', status: 'done', summary: 'usage meters enabled for 1 of 1 account(s)' });
    expect(result.detail).toBe('native-claude (claude): on');
  });

  it('skips when accounts exist but none are meterable', async () => {
    const captured: string[] = [];
    const result = await metersStep.run(context(homeWithAccounts({ schemaVersion: 2, codex: [{ id: 'codex-only', codexHome: null }] })), io([], captured));

    expect(result).toEqual({ id: 'meters', status: 'skipped', summary: 'no meterable accounts' });
    expect(captured).toContain('no accounts with a populated usage meter yet (native Claude only today)');
  });

  it('under --dry-run reports intent, prompts for nothing, and writes no policy file', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    const captured: string[] = [];
    // Empty ScriptedPrompter: a dry run must short-circuit before any prompt.
    const result = await metersStep.run({ ...context(homeDir), dryRun: true }, io([], captured));

    expect(result).toMatchObject({ id: 'meters', status: 'skipped' });
    expect(captured.join('\n')).toMatch(/dry-run/i);
    expect(existsSync(join(homeDir, '.heddle', 'policy', 'meters.json'))).toBe(false);
  });
});

describe('computeMetersPolicy', () => {
  it('maps each decision into a minimal account policy', () => {
    expect(computeMetersPolicy([{ accountId: 'a', meters: true }, { accountId: 'b', meters: false }])).toEqual({
      version: 1,
      accounts: { a: { meters: true }, b: { meters: false } },
    });
  });
});
