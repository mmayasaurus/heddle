import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMetersPolicy, metersStep } from '../../src/wizard/meters-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

describe('metersStep', () => {
  const { track } = useTempResources('heddle-meters-step-test-');

  // Isolation: a HEDDLE_ACCOUNTS exported in the running shell would otherwise make the homeDir-based
  // tests read a real registry (and could leak it into output). Clear it before each test; the one
  // positive test re-stubs it to a fixture path. `undefined` deletes the var (an '' would be a real,
  // empty path). vi.unstubAllEnvs restores the process environment afterward.
  beforeEach(() => vi.stubEnv('HEDDLE_ACCOUNTS', undefined));
  afterEach(() => vi.unstubAllEnvs());

  function homeWithAccounts(accounts: unknown): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'heddle-meters-step-test-'));
    track(homeDir);
    const heddleDir = join(homeDir, '.heddle');
    mkdirSync(heddleDir, { recursive: true });
    writeFileSync(join(heddleDir, 'accounts.json'), JSON.stringify(accounts));
    return homeDir;
  }

  function writePriorPolicy(homeDir: string, policy: unknown): string {
    const policyDir = join(homeDir, '.heddle', 'policy');
    mkdirSync(policyDir, { recursive: true });
    const file = join(policyDir, 'meters.json');
    writeFileSync(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
    return file;
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

  it('reads the registry from HEDDLE_ACCOUNTS when set, not the homeDir default', async () => {
    // The homeDir registry is empty; the real accounts live at the HEDDLE_ACCOUNTS path. accountsStep
    // honors HEDDLE_ACCOUNTS, so meters must read the same file — else it meters an empty registry.
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [] });
    const envDir = mkdtempSync(join(tmpdir(), 'heddle-meters-env-'));
    track(envDir);
    const envRegistry = join(envDir, 'accounts.json');
    writeFileSync(envRegistry, JSON.stringify({ schemaVersion: 2, claude: [{ id: 'env-claude', configDir: null }] }));
    vi.stubEnv('HEDDLE_ACCOUNTS', envRegistry);
    const captured: string[] = [];

    const result = await metersStep.run(context(homeDir), io([true], captured));

    expect(result).toMatchObject({ id: 'meters', status: 'done', summary: 'usage meters enabled for 1 of 1 account(s)' });
    expect(result.detail).toBe('env-claude (claude): on');
    // The policy still lands under homeDir (the persist seam is home-scoped); the split is intended.
    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'policy', 'meters.json'), 'utf8'))).toEqual({
      version: 1, accounts: { 'env-claude': { meters: true } },
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

  it('preserves a saved decision for an account absent from the current registry (merge-preserving rerun)', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    // A prior run configured two accounts; removed-acct is no longer in the registry and must survive.
    const policyFile = writePriorPolicy(homeDir, {
      version: 1, accounts: { 'removed-acct': { meters: false }, 'claude-one': { meters: true } },
    });
    const captured: string[] = [];

    const result = await metersStep.run(context(homeDir), io([false], captured));

    expect(result).toMatchObject({ id: 'meters', status: 'done', summary: 'usage meters enabled for 0 of 1 account(s)' });
    // removed-acct's saved choice is preserved; claude-one is updated to the new answer.
    expect(JSON.parse(readFileSync(policyFile, 'utf8'))).toEqual({
      version: 1, accounts: { 'removed-acct': { meters: false }, 'claude-one': { meters: false } },
    });
  });

  it('fails on a corrupt existing meters policy without overwriting it', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    const policyFile = writePriorPolicy(homeDir, '{ not json');

    // A meterable account exists, but the prior policy is unreadable: fail loudly rather than clobber.
    const result = await metersStep.run(context(homeDir), io([true], []));

    expect(result).toMatchObject({ id: 'meters', status: 'failed' });
    expect(result.summary).toMatch(/corrupt/i);
    expect(result.summary).toContain(policyFile); // HED-602: the resolved path, not a hardcoded ~/.heddle literal
    expect(readFileSync(policyFile, 'utf8')).toBe('{ not json');
  });

  it('fails on a parseable-but-corrupt policy (array accounts) instead of clobbering it', async () => {
    // Valid JSON with an object root but a malformed `accounts` — must fail, not be coerced to {} and
    // overwritten (the merge-preserving contract covers structurally-broken existing policies too).
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    const raw = JSON.stringify({ version: 1, accounts: [] });
    const policyFile = writePriorPolicy(homeDir, raw);

    const result = await metersStep.run(context(homeDir), io([true], []));

    expect(result).toMatchObject({ id: 'meters', status: 'failed' });
    expect(result.summary).toMatch(/corrupt/i);
    expect(readFileSync(policyFile, 'utf8')).toBe(raw);
  });

  it('fails on an existing policy whose account entry has a non-boolean meters', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    const raw = JSON.stringify({ version: 1, accounts: { 'claude-one': { meters: 'yes' } } });
    const policyFile = writePriorPolicy(homeDir, raw);

    const result = await metersStep.run(context(homeDir), io([true], []));

    expect(result).toMatchObject({ id: 'meters', status: 'failed' });
    expect(readFileSync(policyFile, 'utf8')).toBe(raw);
  });

  it('under --dry-run reports intent, prompts for nothing, and writes no policy file', async () => {
    const homeDir = homeWithAccounts({ schemaVersion: 2, claude: [{ id: 'claude-one', configDir: null }] });
    const captured: string[] = [];
    // Empty ScriptedPrompter: a dry run must short-circuit before any prompt.
    const result = await metersStep.run({ ...context(homeDir), dryRun: true }, io([], captured));

    expect(result).toMatchObject({ id: 'meters', status: 'skipped' });
    expect(captured.join('\n')).toMatch(/dry-run/i);
    // HED-602: the preview shows the RESOLVED policy path (home-scoped), never a hardcoded ~/.heddle
    // literal that would be wrong under --home.
    expect(captured.join('\n')).toContain(join(homeDir, '.heddle', 'policy', 'meters.json'));
    expect(captured.join('\n')).not.toContain('~/.heddle');
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

  it('merges into a prior policy, preserving untouched accounts and unknown fields', () => {
    expect(computeMetersPolicy(
      [{ accountId: 'a', meters: false }],
      { version: 1, accounts: { a: { meters: true }, b: { meters: true } }, note: 'keep' },
    )).toEqual({
      version: 1, accounts: { a: { meters: false }, b: { meters: true } }, note: 'keep',
    });
  });
});
