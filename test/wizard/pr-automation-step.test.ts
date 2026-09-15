import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERIC, TS_NODE, prAutomationStep, readPrAutomationTemplates, renderDeterministicReview, resolvePrAutomationAssets } from '../../src/wizard/pr-automation-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

function context(targetDir: string | undefined, dryRun = false): WizardContext {
  return { homeDir: targetDir ?? '/unused', targetDir, dryRun, now: () => new Date(), results: new Map() };
}

function io(answers: unknown[], lines: string[] = []): WizardIO {
  return { prompter: new ScriptedPrompter(answers), report: (line) => lines.push(line) };
}

function targetRepo(tempDir: () => string): string {
  const targetDir = tempDir();
  mkdirSync(join(targetDir, '.git'));
  return targetDir;
}

describe('prAutomationStep', () => {
  const { tempDir } = useTempResources('hed409-pr-automation-');

  it('writes the rendered workflow and byte-identical gitleaks script', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await prAutomationStep().run(context(targetDir), io(['TS/Node']));
    const workflow = readFileSync(join(targetDir, '.github', 'workflows', 'deterministic-review.yml'), 'utf8');
    const script = readFileSync(join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh'));
    const sourceScript = readFileSync(resolvePrAutomationAssets().gitleaksRangeScan);

    expect(result.status).toBe('done');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toMatch(/container:\n(?:.*\n)*?\s+image: .+@sha256:/);
    expect(workflow).toContain('--metrics=off');
    expect(script.equals(sourceScript)).toBe(true);
  });

  it('keeps the vendored gitleaks script byte-identical to heddle’s canonical script (drift guard)', () => {
    // The vendored asset is a security artifact; if heddle's canonical scanner script changes, this reds
    // until the vendored copy is re-synced (R, HED-597). import.meta-relative so it is cwd-independent.
    const vendored = readFileSync(resolvePrAutomationAssets().gitleaksRangeScan);
    const canonical = readFileSync(fileURLToPath(new URL('../../.github/scripts/gitleaks-range-scan.sh', import.meta.url)));
    expect(vendored.equals(canonical)).toBe(true);
  });

  it('keeps all language-coupled rendering sites in sync for the generic preset', () => {
    const tsNode = renderDeterministicReview(TS_NODE);
    const generic = renderDeterministicReview(GENERIC);

    expect(tsNode).toContain('--config p/typescript --config p/nodejs');
    expect(generic).toContain('--config p/default');
    expect(generic).not.toContain('p/typescript');
    expect(generic).toContain("grep -cE '.+'");
    expect(generic).toContain("grep -vE '(^|/)(node_modules|dist)/'");
    expect(generic).toContain('branches: [main]');
    expect(generic).not.toContain('__HEDDLE_');
  });

  it('makes all three code-scanning uploads non-blocking', () => {
    expect(renderDeterministicReview(TS_NODE).match(/continue-on-error: true/g)).toHaveLength(3);
  });

  it('preserves an existing target file and reports it', async () => {
    const targetDir = targetRepo(tempDir);
    const workflowPath = join(targetDir, '.github', 'workflows', 'deterministic-review.yml');
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(workflowPath, 'operator workflow\n');
    const lines: string[] = [];

    await prAutomationStep().run(context(targetDir), io(['TS/Node'], lines));

    expect(readFileSync(workflowPath, 'utf8')).toBe('operator workflow\n');
    expect(lines.some((line) => line.includes(`already present — left unchanged: ${workflowPath}`))).toBe(true);
  });

  it('reports resolved paths and writes nothing during dry-run', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await prAutomationStep().run(context(targetDir, true), io([], lines));
    const workflowPath = join(targetDir, '.github', 'workflows', 'deterministic-review.yml');
    const scriptPath = join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh');

    expect(result.status).toBe('skipped');
    expect(existsSync(workflowPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
    expect(lines.join('\n')).toContain(workflowPath);
    expect(lines.join('\n')).toContain(scriptPath);
  });

  it('only applies to a target repository root', () => {
    const targetDir = tempDir();
    expect(prAutomationStep().applies?.(context(undefined))).toBe(false);
    expect(prAutomationStep().applies?.(context(targetDir))).toBe(false);
    mkdirSync(join(targetDir, '.git'));
    expect(prAutomationStep().applies?.(context(targetDir))).toBe(true);
  });

  it('resolves and reads the package-root bundled templates', () => {
    const assets = resolvePrAutomationAssets();
    const templates = readPrAutomationTemplates();

    expect(existsSync(assets.workflowTemplate)).toBe(true);
    expect(existsSync(assets.gitleaksRangeScan)).toBe(true);
    expect(templates.workflowTemplate).toContain('Deterministic Review');
    expect(templates.gitleaksRangeScan).toContain('set -eu');
  });
});
