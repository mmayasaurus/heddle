import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rulesStep } from '../../src/wizard/rules-step.js';
import { resolvePreset } from '../../src/wizard/presets.js';
import { policyPath } from '../../src/wizard/persist.js';
import { ScriptedPrompter, type Prompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

function seedCatalog(root: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'no-rm-recursive-force.yaml'), 'id: no-rm-recursive-force\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: false\nsubagent_aware: false\nmessage: Do not recursively force-remove files.\nfail_open: true\n');
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
});
