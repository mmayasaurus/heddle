import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evenSplit, runSpreadPolicy } from '../../src/wizard/spread-policy.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
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
});
