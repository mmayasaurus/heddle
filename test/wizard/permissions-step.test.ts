import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { permissionsStep } from '../../src/wizard/permissions-step.js';
import type { Prompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

const categories = [
  'file-deletion',
  'git-history-rewrite',
  'db-destructive',
  'disk-level',
  'credential-writes',
  'package-removal',
] as const;

type Posture = 'block' | 'ask' | 'nudge' | 'off';
type Category = typeof categories[number];

class CapturingPrompter implements Prompter {
  readonly selections: { question: string; choices: readonly string[] }[] = [];

  constructor(private readonly answers: string[]) {}

  async text(): Promise<string> { throw new Error('unexpected text prompt'); }
  async select(question: string, choices: readonly string[]): Promise<string> {
    this.selections.push({ question, choices });
    const answer = this.answers.shift();
    if (answer === undefined) return choices[0] ?? '';
    if (!choices.includes(answer)) throw new Error(`invalid test choice: ${answer}`);
    return answer;
  }
  async confirm(): Promise<boolean> { throw new Error('unexpected confirmation prompt'); }
  async secret(): Promise<string> { throw new Error('unexpected secret prompt'); }
  close(): void {}
}

describe('permissionsStep', () => {
  const { track } = useTempResources('heddle-permissions-step-test-');

  function homeDir(): string {
    const home = mkdtempSync(join(tmpdir(), 'heddle-permissions-step-test-'));
    track(home);
    return home;
  }

  function policyFile(home: string): string {
    return join(home, '.heddle', 'policy', 'permissions.json');
  }

  function writePriorPolicy(home: string, policy: unknown): string {
    mkdirSync(join(home, '.heddle', 'policy'), { recursive: true });
    const file = policyFile(home);
    writeFileSync(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
    return file;
  }

  function context(home: string): WizardContext {
    return { homeDir: home, now: () => new Date(0), results: new Map() };
  }

  function io(prompter: Prompter, lines: string[]): WizardIO {
    return { prompter, report: (line) => lines.push(line) };
  }

  function selectionDefaults(prompter: CapturingPrompter): Record<string, string> {
    return Object.fromEntries(prompter.selections.slice(1).map(({ question, choices }) => [question, choices[0]]));
  }

  function profile(posture: Posture): Record<Category, Posture> {
    return Object.fromEntries(categories.map((category) => [category, posture])) as Record<Category, Posture>;
  }

  it('under --dry-run reports intent, prompts for nothing, and writes no policy file', async () => {
    const home = homeDir();
    const lines: string[] = [];
    const prompter = new CapturingPrompter([]);

    const result = await permissionsStep().run({ ...context(home), dryRun: true }, io(prompter, lines));

    expect(result).toMatchObject({ id: 'permissions', status: 'skipped' });
    expect(lines.join('\n')).toMatch(/dry-run/i);
    expect(prompter.selections).toEqual([]);
    expect(existsSync(policyFile(home))).toBe(false);
  });

  it.each([
    ['strict', 'ask', 'block'],
    ['standard', 'nudge', 'nudge'],
    ['minimal', 'nudge', 'nudge'],
  ] as const)('pre-fills the exact %s preset matrix', async (preset, interactiveDefault, unattendedDefault) => {
    const home = homeDir();
    const prompter = new CapturingPrompter([preset]);

    await permissionsStep().run(context(home), io(prompter, []));

    const defaults = selectionDefaults(prompter);
    for (const category of categories) {
      const irreversible = ['file-deletion', 'git-history-rewrite', 'credential-writes'].includes(category);
      const interactive = preset === 'standard' && irreversible ? 'ask' : interactiveDefault;
      const unattended = (preset === 'strict' || (preset === 'standard' && irreversible)) ? 'block' : unattendedDefault;
      expect(defaults[`interactive: ${category}`]).toBe(interactive);
      expect(defaults[`unattended: ${category}`]).toBe(unattended);
    }
  });

  it('merges into an existing policy without dropping unknown keys', async () => {
    const home = homeDir();
    const file = writePriorPolicy(home, {
      version: 1,
      activeProfile: 'unattended',
      profiles: { interactive: profile('nudge'), unattended: profile('nudge') },
      future: { keep: true },
    });

    await permissionsStep().run(context(home), io(new CapturingPrompter(['minimal']), []));

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 1,
      activeProfile: 'unattended',
      future: { keep: true },
      profiles: { interactive: expect.any(Object), unattended: expect.any(Object) },
    });
  });

  it('fails loudly and does not overwrite corrupt prior JSON', async () => {
    const home = homeDir();
    const file = writePriorPolicy(home, '{ bad json');

    const result = await permissionsStep().run(context(home), io(new CapturingPrompter([]), []));

    expect(result).toMatchObject({ id: 'permissions', status: 'failed' });
    expect(result.summary).toMatch(/corrupt/i);
    expect(readFileSync(file, 'utf8')).toBe('{ bad json');
  });

  it('coerces unattended ask choices to block and echoes the coercion', async () => {
    const home = homeDir();
    const lines: string[] = [];
    const answers = ['minimal', ...categories.map(() => 'nudge'), ...categories.map(() => 'ask')];

    await permissionsStep().run(context(home), io(new CapturingPrompter(answers), lines));

    const written = JSON.parse(readFileSync(policyFile(home), 'utf8'));
    expect(written.profiles.unattended).toEqual(Object.fromEntries(categories.map((category) => [category, 'block'])));
    expect(lines.join('\n')).toMatch(/unattended.*ask.*block|ask.*block.*unattended/i);
  });

  it('pre-fills choices from an existing policy on re-run', async () => {
    const home = homeDir();
    writePriorPolicy(home, {
      version: 1,
      activeProfile: 'interactive',
      profiles: {
        interactive: Object.fromEntries(categories.map((category) => [category, category === 'disk-level' ? 'off' : 'nudge'])),
        unattended: Object.fromEntries(categories.map((category) => [category, category === 'disk-level' ? 'block' : 'nudge'])),
      },
    });
    const prompter = new CapturingPrompter(['strict']);

    await permissionsStep().run(context(home), io(prompter, []));

    const defaults = selectionDefaults(prompter);
    expect(defaults['interactive: disk-level']).toBe('off');
    expect(defaults['unattended: disk-level']).toBe('block');
  });

  it('rejects an existing policy with an invalid posture value without overwriting it', async () => {
    const home = homeDir();
    const raw = JSON.stringify({
      version: 1,
      activeProfile: 'interactive',
      profiles: { interactive: { 'file-deletion': 'permit' }, unattended: {} },
    });
    const file = writePriorPolicy(home, raw);

    const result = await permissionsStep().run(context(home), io(new CapturingPrompter([]), []));

    expect(result).toMatchObject({ id: 'permissions', status: 'failed' });
    expect(result.summary).toMatch(/corrupt/i);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});
