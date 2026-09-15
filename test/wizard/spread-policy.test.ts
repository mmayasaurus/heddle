import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evenSplit, runSpreadPolicy, spreadStep } from '../../src/wizard/spread-policy.js';
import { ScriptedPrompter, type Prompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

interface RegistryRow { id: string; loggedIn?: boolean; }
interface RegistryRows { claude?: RegistryRow[]; codex?: RegistryRow[]; cursor?: RegistryRow[]; }

function seedRegistry(dir: string, rows: RegistryRows): string {
  const path = join(dir, 'accounts.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, ...rows }, null, 2));
  return path;
}

const threeClaudeAccounts: RegistryRows = {
  claude: [{ id: 'acct1', loggedIn: true }, { id: 'acct2', loggedIn: true }, { id: 'acct3', loggedIn: true }],
};

describe('evenSplit', () => {
  it('matches the golden even splits', () => {
    expect(evenSplit(7, 4)).toEqual([2, 2, 2, 1]);
    expect(evenSplit(4, 4)).toEqual([1, 1, 1, 1]);
    expect(evenSplit(1, 4)).toEqual([1, 0, 0, 0]);
    expect(evenSplit(0, 4)).toEqual([0, 0, 0, 0]);
    expect(evenSplit(10, 3)).toEqual([4, 3, 3]);
    expect(evenSplit(5, 1)).toEqual([5]);
  });

  it('rejects a non-positive account count', () => {
    expect(() => evenSplit(3, 0)).toThrow();
  });

  it('rejects a negative session count', () => {
    expect(() => evenSplit(-1, 4)).toThrow();
  });

  it('sums to sessions and keeps max - min <= 1 across a range of sessions and account counts', () => {
    for (let sessions = 0; sessions <= 20; sessions++) {
      for (let accounts = 1; accounts <= 6; accounts++) {
        const split = evenSplit(sessions, accounts);
        expect(split.reduce((sum, n) => sum + n, 0)).toBe(sessions);
        expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('runSpreadPolicy', () => {
  const { tempDir } = useTempResources('hed474-');

  it('captures the even spread and per-account cap, warning when the cap cannot fit every session', async () => {
    const registryPath = seedRegistry(tempDir(), threeClaudeAccounts);
    const lines: string[] = [];
    const report = (l: string) => lines.push(l);
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, true, true, '7', '2', true]), report,
    });
    expect(result).toEqual({
      policy: { strategy: 'even-spread', provider: 'claude', accounts: ['acct1', 'acct2', 'acct3'], capPerAccount: 2 },
    });
    expect(lines.some((l) => l.includes('7 session(s) across 3'))).toBe(true);
    expect(lines.some((l) => l.includes('⚠'))).toBe(true);
  });

  it('defaults sessions to the participant count and the cap to the split ceiling', async () => {
    const registryPath = seedRegistry(tempDir(), threeClaudeAccounts);
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, true, true, '', '', true]),
    });
    expect(result.policy.capPerAccount).toBe(1);
    expect(result.policy.accounts.length).toBe(3);
  });

  it('captures only the accounts the user opts into', async () => {
    const registryPath = seedRegistry(tempDir(), threeClaudeAccounts);
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, false, true, '4', '2', true]),
    });
    expect(result.policy.accounts).toEqual(['acct1', 'acct3']);
  });

  it('skips with a report line when no Claude accounts are registered', async () => {
    const registryPath = seedRegistry(tempDir(), { codex: [{ id: 'cod1' }] });
    const lines: string[] = [];
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([]), report: (l) => lines.push(l),
    });
    expect(result).toEqual({ policy: { strategy: 'even-spread', provider: 'claude', accounts: [], capPerAccount: 0 } });
    expect(lines.some((l) => l.includes('No Claude accounts'))).toBe(true);
  });

  it('returns a noop policy and reports when the user declines to save', async () => {
    const registryPath = seedRegistry(tempDir(), threeClaudeAccounts);
    const lines: string[] = [];
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, true, true, '3', '1', false]), report: (l) => lines.push(l),
    });
    expect(result).toEqual({ policy: { strategy: 'even-spread', provider: 'claude', accounts: [], capPerAccount: 0 } });
    expect(lines.some((l) => l.includes('not saved'))).toBe(true);
  });

  it('offers only Claude accounts when the registry has mixed providers', async () => {
    const registryPath = seedRegistry(tempDir(), {
      claude: [{ id: 'acct1' }, { id: 'acct2' }],
      codex: [{ id: 'cod1' }],
      cursor: [{ id: 'cur1' }],
    });
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, true, '2', '1', true]),
    });
    expect(result.policy.accounts).toEqual(['acct1', 'acct2']);
  });

  it('falls back to the default when a numeric entry is malformed instead of truncating it', async () => {
    const registryPath = seedRegistry(tempDir(), threeClaudeAccounts);
    const lines: string[] = [];
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([true, true, true, '2.5', '7abc', true]), report: (l) => lines.push(l),
    });
    // '2.5' and '7abc' must be REJECTED, not truncated to 2 / 7: sessions falls back to the participant
    // count (3), and the cap falls back to the ceiling ceil(3/3) = 1. (Fails on Number.parseInt.)
    expect(result.policy.capPerAccount).toBe(1);
    expect(lines.some((l) => l.includes('3 session(s) across 3'))).toBe(true);
  });

  it('reports and skips without throwing when the registry file is corrupt', async () => {
    const registryPath = join(tempDir(), 'accounts.json');
    writeFileSync(registryPath, '{ this is not valid json');
    const lines: string[] = [];
    const result = await runSpreadPolicy({ registryPath }, {
      prompter: new ScriptedPrompter([]), report: (l) => lines.push(l),
    });
    expect(result).toEqual({ policy: { strategy: 'even-spread', provider: 'claude', accounts: [], capPerAccount: 0 } });
    expect(lines.some((l) => l.includes('Could not read the account registry'))).toBe(true);
  });
});

// The spreadStep wrapper reads the registry from <home>/.heddle/accounts.json (where the accounts step
// writes it), so seed it there rather than flat in tempDir().
function seedRegistryUnderHome(homeDir: string, rows: RegistryRows): void {
  const dir = join(homeDir, '.heddle');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ schemaVersion: 2, ...rows }, null, 2));
}

function makeCtx(homeDir: string, dryRun = false): WizardContext {
  return { homeDir, dryRun, now: () => new Date('2026-09-15T00:00:00Z'), results: new Map() };
}

function makeIo(prompter: Prompter): { io: WizardIO; lines: string[] } {
  const lines: string[] = [];
  return { io: { prompter, report: (l) => lines.push(l) }, lines };
}

const policyFileIn = (homeDir: string) => join(homeDir, '.heddle', 'policy', 'spread.json');

describe('spreadStep', () => {
  const { tempDir } = useTempResources('hed579-');
  const savedEnv = process.env.HEDDLE_ACCOUNTS;
  // The step derives the registry path from ctx.homeDir unless HEDDLE_ACCOUNTS overrides it; clear the
  // env for the home-derived cases so a value in the runner env cannot silently redirect the read.
  beforeEach(() => { delete process.env.HEDDLE_ACCOUNTS; });
  afterEach(() => { if (savedEnv === undefined) delete process.env.HEDDLE_ACCOUNTS; else process.env.HEDDLE_ACCOUNTS = savedEnv; });

  it('writes the captured policy to <home>/.heddle/policy/spread.json and reports done', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    const { io } = makeIo(new ScriptedPrompter([true, true, true, '7', '2', true]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('done');
    expect(result.summary).toContain('even-spread');
    expect(result.summary).toContain('cap 2/account');
    expect(existsSync(policyFileIn(home))).toBe(true);
    expect(JSON.parse(readFileSync(policyFileIn(home), 'utf8'))).toEqual({
      strategy: 'even-spread', provider: 'claude', accounts: ['acct1', 'acct2', 'acct3'], capPerAccount: 2,
    });
  });

  it('prompts for nothing and writes nothing under --dry-run, returning skipped', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    // Empty script: ScriptedPrompter throws "answer script exhausted" if the step prompts at all, so a
    // passing test proves dry-run consumed zero prompts.
    const { io, lines } = makeIo(new ScriptedPrompter([]));
    const result = await spreadStep.run(makeCtx(home, true), io);
    expect(result.status).toBe('skipped');
    expect(lines.some((l) => l.includes('dry-run'))).toBe(true);
    expect(existsSync(policyFileIn(home))).toBe(false);
  });

  it('writes no policy file and reports skipped when the operator declines to save', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    const { io } = makeIo(new ScriptedPrompter([true, true, true, '3', '1', false]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('skipped');
    expect(existsSync(policyFileIn(home))).toBe(false);
  });

  it('writes no policy file and reports skipped when no Claude accounts are registered', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, { codex: [{ id: 'cod1' }] });
    const { io } = makeIo(new ScriptedPrompter([]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('skipped');
    expect(existsSync(policyFileIn(home))).toBe(false);
  });

  it('honors HEDDLE_ACCOUNTS for the registry while writing the policy under ctx.homeDir', async () => {
    const home = tempDir();
    const registryHome = tempDir();
    seedRegistryUnderHome(registryHome, threeClaudeAccounts);
    process.env.HEDDLE_ACCOUNTS = join(registryHome, '.heddle', 'accounts.json');
    const { io } = makeIo(new ScriptedPrompter([true, true, true, '3', '1', true]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('done');
    // Registry read from HEDDLE_ACCOUNTS; policy written under ctx.homeDir, NOT the registry's home.
    expect(existsSync(policyFileIn(home))).toBe(true);
    expect(existsSync(policyFileIn(registryHome))).toBe(false);
  });

  it('replaces the spread-owned fields on a re-run (deselected accounts do not linger)', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    // First run: all three accounts, cap 2.
    await spreadStep.run(makeCtx(home), makeIo(new ScriptedPrompter([true, true, true, '7', '2', true])).io);
    // Second run: only acct1, cap 1 — the owned fields must fully REPLACE, not union the account lists.
    await spreadStep.run(makeCtx(home), makeIo(new ScriptedPrompter([true, false, false, '1', '1', true])).io);
    expect(JSON.parse(readFileSync(policyFileIn(home), 'utf8'))).toEqual({
      strategy: 'even-spread', provider: 'claude', accounts: ['acct1'], capPerAccount: 1,
    });
  });

  it('reports failed (not skipped) and writes no policy when the account registry is corrupt', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.heddle'), { recursive: true });
    writeFileSync(join(home, '.heddle', 'accounts.json'), '{ not valid json');
    // Empty script: the corrupt-registry pre-check fails BEFORE any prompt, so nothing is consumed.
    const { io } = makeIo(new ScriptedPrompter([]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('failed');
    expect(existsSync(policyFileIn(home))).toBe(false);
  });

  it('merge-preserves unknown fields in an existing spread.json and overwrites only the owned fields', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    mkdirSync(join(home, '.heddle', 'policy'), { recursive: true });
    // A prior policy carrying extra fields a future consumer/migration might add.
    writeFileSync(policyFileIn(home), JSON.stringify({
      strategy: 'even-spread', provider: 'claude', accounts: ['old'], capPerAccount: 9,
      schemaVersion: 2, note: 'keep me',
    }));
    const { io } = makeIo(new ScriptedPrompter([true, false, false, '1', '1', true]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('done');
    expect(JSON.parse(readFileSync(policyFileIn(home), 'utf8'))).toEqual({
      strategy: 'even-spread', provider: 'claude', accounts: ['acct1'], capPerAccount: 1, // owned fields updated
      schemaVersion: 2, note: 'keep me', // unknown fields preserved
    });
  });

  it('fails without clobbering a corrupt existing spread.json', async () => {
    const home = tempDir();
    seedRegistryUnderHome(home, threeClaudeAccounts);
    mkdirSync(join(home, '.heddle', 'policy'), { recursive: true });
    writeFileSync(policyFileIn(home), 'not json at all');
    const { io } = makeIo(new ScriptedPrompter([true, true, true, '3', '1', true]));
    const result = await spreadStep.run(makeCtx(home), io);
    expect(result.status).toBe('failed');
    expect(readFileSync(policyFileIn(home), 'utf8')).toBe('not json at all'); // left exactly as it was
  });
});
