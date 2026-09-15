import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existingRuleSelection, rulesStep, loadExistingRulesPolicy } from '../../src/wizard/rules-step.js';
import { resolvePreset } from '../../src/wizard/presets.js';
import { policyPath } from '../../src/wizard/persist.js';
import { ScriptedPrompter, type Prompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

function seedCatalog(root: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'no-rm-recursive-force.yaml'), 'id: no-rm-recursive-force\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: false\nsubagent_aware: false\nmessage: Do not recursively force-remove files.\nfail_open: true\n');
}

function seedPolicy(homeDir: string, content: string): string {
  const path = policyPath(homeDir, 'rules');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function context(homeDir: string, dryRun = false): WizardContext {
  return { homeDir, dryRun, now: () => new Date(), results: new Map() };
}

function io(answers: unknown[], lines: string[] = []): WizardIO {
  return { prompter: new ScriptedPrompter(answers), report: (line) => lines.push(line) };
}

class RecordingPrompter implements Prompter {
  readonly calls: { question: string; defaultValue?: boolean }[] = [];

  constructor(private readonly answers: unknown[]) {}

  private next(): unknown {
    if (!this.answers.length) throw new Error('answer script exhausted');
    return this.answers.shift();
  }

  async text(_question: string, defaultValue?: string): Promise<string> {
    const answer = this.next();
    return answer === undefined ? defaultValue ?? '' : String(answer);
  }

  async select(_question: string, _choices: readonly string[]): Promise<string> {
    return String(this.next());
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    this.calls.push({ question, defaultValue });
    const answer = this.next();
    if (typeof answer !== 'boolean') throw new Error('scripted confirmation must be boolean');
    return answer;
  }

  async secret(): Promise<string> { throw new Error('not expected'); }

  close(): void {}
}

describe('rulesStep', () => {
  const { tempDir } = useTempResources('hed544-');

  it('writes an accepted minimal preset', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', true, true]));
    const written = JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'));

    expect(written).toEqual({ schemaVersion: 1, rules: resolvePreset('minimal', catalogRoot) });
    expect(result.status).toBe('done');
    expect(result.summary).toContain('minimal');
    expect(result.summary).toContain('no-rm-recursive-force');
  });

  it('lets an operator fine-tune a preset before saving', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', false, false, true]));

    expect(JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'))).toEqual({ schemaVersion: 1, rules: [] });
    expect(result.status).toBe('done');
  });

  it('fine-tune pre-fills the hooks chooser from the preset', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    const recording = new RecordingPrompter(['minimal', false, true, false, true]);

    await rulesStep(catalogRoot).run(context(homeDir), { prompter: recording, report: () => {} });

    expect(recording.calls.find((call) => call.question.includes('include no-rm-recursive-force'))?.defaultValue).toBe(true);
  });

  it('does not prompt or write during dry-run', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    const lines: string[] = [];

    const result = await rulesStep(catalogRoot).run(context(homeDir, true), io([], lines));

    expect(existsSync(policyPath(homeDir, 'rules'))).toBe(false);
    expect(result.status).toBe('skipped');
    expect(lines.some((line) => line.includes('dry-run'))).toBe(true);
  });

  it('does not write when saving is declined', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', true, false]));

    expect(existsSync(policyPath(homeDir, 'rules'))).toBe(false);
    expect(result.status).toBe('skipped');
  });

  it('writes a custom selection including enforcement', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['custom (choose each rule)', true, true, true]));

    expect(JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'))).toEqual({
      schemaVersion: 1,
      rules: [{ id: 'no-rm-recursive-force', enforce: true }],
    });
    expect(result.status).toBe('done');
  });

  it('pre-fills a custom chooser from the existing policy', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    seedPolicy(homeDir, JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'no-rm-recursive-force', enforce: true }],
    }));
    const recording = new RecordingPrompter(['custom (choose each rule)', true, true, true]);

    await rulesStep(catalogRoot).run(context(homeDir), { prompter: recording, report: () => {} });

    expect(recording.calls.find((call) => call.question.includes('include no-rm-recursive-force'))?.defaultValue).toBe(true);
    expect(recording.calls.find((call) => call.question.includes('enable ENFORCEMENT for no-rm-recursive-force'))?.defaultValue).toBe(true);
  });

  it('starts a first-run custom chooser blank', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    const recording = new RecordingPrompter(['custom (choose each rule)', true, true, true]);

    await rulesStep(catalogRoot).run(context(homeDir), { prompter: recording, report: () => {} });

    expect(recording.calls.find((call) => call.question.includes('include no-rm-recursive-force'))?.defaultValue).toBe(false);
  });

  it('leaves a custom chooser blank when existing rules are malformed', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    seedPolicy(homeDir, JSON.stringify({ schemaVersion: 1, rules: 'oops' }));
    const recording = new RecordingPrompter(['custom (choose each rule)', true, true, true]);

    await expect(rulesStep(catalogRoot).run(context(homeDir), { prompter: recording, report: () => {} })).resolves.toBeDefined();

    expect(recording.calls.find((call) => call.question.includes('include no-rm-recursive-force'))?.defaultValue).toBe(false);
  });

  it('preserves unknown top-level fields on a rerun (merge-preserving contract)', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    // A prior write, plus fields a newer consumer/migration added that this step does not own.
    seedPolicy(homeDir, JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'stale-rule', enforce: true }],
      lastReviewedAt: '2026-09-01T00:00:00Z',
      meta: { source: 'migration-7' },
    }) + '\n');

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', true, true]));
    const written = JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'));

    expect(result.status).toBe('done');
    // Owned fields are replaced with the new selection…
    expect(written.rules).toEqual(resolvePreset('minimal', catalogRoot));
    expect(written.schemaVersion).toBe(1);
    // …while unknown top-level fields survive (not clobbered).
    expect(written.lastReviewedAt).toBe('2026-09-01T00:00:00Z');
    expect(written.meta).toEqual({ source: 'migration-7' });
  });

  it('fails fast on a malformed existing policy file, before any prompt', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    const path = seedPolicy(homeDir, '{ this is not valid json');

    // No prompt answers: if the existing policy were not validated first, run() would reach the preset
    // select() and the ScriptedPrompter would throw "answer script exhausted" instead — so asserting the
    // specific "not valid JSON" error proves validation happens before the operator is prompted.
    await expect(rulesStep(catalogRoot).run(context(homeDir), io([]))).rejects.toThrow(/not valid JSON/);
    // The unparseable file is left exactly as-is, never overwritten.
    expect(readFileSync(path, 'utf8')).toBe('{ this is not valid json');
  });

  it('names the resolved policy path (not a hardcoded ~) in the save prompt under a custom home', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    const recording = new RecordingPrompter(['minimal', true, false]); // minimal, accept as-is, decline save

    await rulesStep(catalogRoot).run(context(homeDir), { prompter: recording, report: () => {} });

    const savePrompt = recording.calls.find((call) => call.question.startsWith('Save these rules'));
    expect(savePrompt?.question).toContain(policyPath(homeDir, 'rules'));
    expect(savePrompt?.question).not.toContain('~/.heddle');
  });

  it('names the resolved policy path in dry-run output', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    const lines: string[] = [];

    await rulesStep(catalogRoot).run(context(homeDir, true), io([], lines));

    expect(lines.some((line) => line.includes(policyPath(homeDir, 'rules')))).toBe(true);
  });
});

describe('loadExistingRulesPolicy', () => {
  const { tempDir } = useTempResources('hed544-load-');

  it('returns {} when the file is absent (a fresh write)', () => {
    expect(loadExistingRulesPolicy(policyPath(tempDir(), 'rules'))).toEqual({});
  });

  it('returns the parsed object, preserving extra fields', () => {
    const path = seedPolicy(tempDir(), JSON.stringify({ schemaVersion: 1, rules: [], note: 'keep' }));
    expect(loadExistingRulesPolicy(path)).toEqual({ schemaVersion: 1, rules: [], note: 'keep' });
  });

  it('throws on unparseable JSON rather than returning a default', () => {
    const path = seedPolicy(tempDir(), 'not json');
    expect(() => loadExistingRulesPolicy(path)).toThrow(/not valid JSON/);
  });

  it('throws when the top-level value is an array, not an object', () => {
    const path = seedPolicy(tempDir(), '[1, 2, 3]');
    expect(() => loadExistingRulesPolicy(path)).toThrow(/expected a JSON object, found an array/);
  });

  it('throws on a schemaVersion this writer does not own', () => {
    const path = seedPolicy(tempDir(), JSON.stringify({ schemaVersion: 2, rules: [] }));
    expect(() => loadExistingRulesPolicy(path)).toThrow(/schemaVersion/);
  });
});

describe('existingRuleSelection', () => {
  it('returns a valid rules array', () => {
    const rules = [{ id: 'no-rm-recursive-force', enforce: true }];
    expect(existingRuleSelection({ rules })).toEqual(rules);
  });

  it('returns undefined when rules are absent', () => {
    expect(existingRuleSelection({})).toBeUndefined();
  });

  it('returns undefined when rules are not an array', () => {
    expect(existingRuleSelection({ rules: 'oops' })).toBeUndefined();
  });

  it('keeps only valid entries from a mixed rules array', () => {
    expect(existingRuleSelection({
      rules: [
        { id: 'valid', enforce: false },
        { id: 'missing-enforce' },
        { id: 1, enforce: true },
        null,
        [],
      ],
    })).toEqual([{ id: 'valid', enforce: false }]);
    expect(existingRuleSelection({ rules: [null, 'invalid'] })).toBeUndefined();
  });
});
