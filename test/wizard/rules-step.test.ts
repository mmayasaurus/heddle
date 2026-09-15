import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rulesStep } from '../../src/wizard/rules-step.js';
import { resolvePreset } from '../../src/wizard/presets.js';
import { policyPath } from '../../src/wizard/persist.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
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

describe('rulesStep', () => {
  const { tempDir } = useTempResources('hed544-');

  it('writes an accepted minimal preset', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', true, true]));
    const written = JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'));

    expect(written).toEqual(resolvePreset('minimal', catalogRoot));
    expect(result.status).toBe('done');
    expect(result.summary).toContain('minimal');
    expect(result.summary).toContain('no-rm-recursive-force');
  });

  it('lets an operator fine-tune a preset before saving', async () => {
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);

    const result = await rulesStep(catalogRoot).run(context(homeDir), io(['minimal', false, false, true]));

    expect(JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'))).toEqual([]);
    expect(result.status).toBe('done');
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

    expect(JSON.parse(readFileSync(policyPath(homeDir, 'rules'), 'utf8'))).toEqual([
      { id: 'no-rm-recursive-force', enforce: true },
    ]);
    expect(result.status).toBe('done');
  });
});
