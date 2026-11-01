import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cdAutomationStep, readCdTemplate, resolveCdAutomationAssets } from '../../src/wizard/cd-automation-step.js';
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

const workflows = [
  { templateKey: 'releaseTemplate', templateName: 'release-on-tag.yml.tmpl', fileName: 'release-on-tag.yml', jobName: 'release', environment: 'release' },
  { templateKey: 'publishTemplate', templateName: 'publish.yml.tmpl', fileName: 'publish.yml', jobName: 'publish', environment: 'publish' },
  { templateKey: 'deployTemplate', templateName: 'deploy.yml.tmpl', fileName: 'deploy.yml', jobName: 'deploy', environment: 'production' },
] as const;

describe('cdAutomationStep', () => {
  const { tempDir } = useTempResources('hed647-cd-automation-');

  it('reports all workflow paths and writes nothing during dry-run', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await cdAutomationStep().run(context(targetDir, true), io([], lines));

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('dry-run');
    expect(lines.join('\n')).toContain('workflow_dispatch');
    for (const workflow of workflows) {
      const path = join(targetDir, '.github', 'workflows', workflow.fileName);
      expect(lines.join('\n')).toContain(path);
      expect(existsSync(path)).toBe(false);
    }
  });

  it('skips when no target directory was selected', async () => {
    const result = await cdAutomationStep().run(context(undefined), io([]));

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('no target directory');
  });

  it('leaves every workflow absent when the gate is declined', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await cdAutomationStep().run(context(targetDir), io([false]));

    expect(result.status).toBe('skipped');
    for (const workflow of workflows) {
      expect(existsSync(join(targetDir, '.github', 'workflows', workflow.fileName))).toBe(false);
    }
  });

  it('writes all selected workflows byte-identically', async () => {
    const targetDir = targetRepo(tempDir);
    const assets = resolveCdAutomationAssets();
    const result = await cdAutomationStep().run(context(targetDir), io([true, true, true, true]));

    expect(result.status).toBe('done');
    for (const workflow of workflows) {
      const path = join(targetDir, '.github', 'workflows', workflow.fileName);
      expect(readFileSync(path, 'utf8')).toBe(readCdTemplate(assets[workflow.templateKey]));
    }
  });

  it('honors declining every workflow after accepting the gate', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await cdAutomationStep().run(context(targetDir), io([true, false, false, false]));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('declined');
    for (const workflow of workflows) {
      expect(existsSync(join(targetDir, '.github', 'workflows', workflow.fileName))).toBe(false);
    }
  });

  it('writes only the release workflow when it is the sole opt-in', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await cdAutomationStep().run(context(targetDir), io([true, true, false, false]));

    expect(result.status).toBe('done');
    expect(existsSync(join(targetDir, '.github', 'workflows', 'release-on-tag.yml'))).toBe(true);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'publish.yml'))).toBe(false);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'deploy.yml'))).toBe(false);
  });

  it('preserves an existing selected workflow and writes the other selected workflows', async () => {
    const targetDir = targetRepo(tempDir);
    const releasePath = join(targetDir, '.github', 'workflows', 'release-on-tag.yml');
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(releasePath, 'operator workflow\n');
    const lines: string[] = [];

    const result = await cdAutomationStep().run(context(targetDir), io([true, true, true, true], lines));

    expect(result.status).toBe('done');
    expect(readFileSync(releasePath, 'utf8')).toBe('operator workflow\n');
    expect(lines).toContain(`CD automation: already present — left unchanged: ${releasePath}`);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'publish.yml'))).toBe(true);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'deploy.yml'))).toBe(true);
  });

  it('does not make scaffold safety claims about an existing unread workflow', async () => {
    const targetDir = targetRepo(tempDir);
    const deployPath = join(targetDir, '.github', 'workflows', 'deploy.yml');
    const unsafeWorkflow = 'on: {push: {branches: [main]}}\njobs: {x: {runs-on: ubuntu-latest, steps: []}}\n';
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(deployPath, unsafeWorkflow);
    const lines: string[] = [];

    const result = await cdAutomationStep().run(context(targetDir), io([true, false, false, true], lines));

    expect(result.status).toBe('done');
    expect(readFileSync(deployPath, 'utf8')).toBe(unsafeWorkflow);
    expect(lines.join('\n')).not.toContain('manual-dispatch-only');
    expect(lines.join('\n')).not.toContain('production');
    expect(lines.join('\n')).toContain('did not read or validate');
    expect(lines.join('\n')).toContain(deployPath);
  });

  it('only applies to a target repository root and resolves all bundled templates', () => {
    const targetDir = tempDir();
    const assets = resolveCdAutomationAssets();

    expect(cdAutomationStep().applies?.(context(undefined))).toBe(false);
    expect(cdAutomationStep().applies?.(context(targetDir))).toBe(false);
    mkdirSync(join(targetDir, '.git'));
    expect(cdAutomationStep().applies?.(context(targetDir))).toBe(true);
    for (const workflow of workflows) {
      expect(existsSync(assets[workflow.templateKey])).toBe(true);
    }
  });

  it('fails loudly and never escapes when .github is a symlink pointing outside the repo (HED-650)', async () => {
    const targetDir = targetRepo(tempDir);
    const outside = tempDir(); // an attacker-chosen destination OUTSIDE the repo
    symlinkSync(outside, join(targetDir, '.github')); // git carries symlinks as content — a repo can ship this
    const lines: string[] = [];

    // Proceed the gate and accept the first workflow → reaches the guarded write, which refuses the symlink.
    const result = await cdAutomationStep().run(context(targetDir), io([true, true, true, true], lines));

    expect(result.status).toBe('failed');
    // Target the reported DETAIL line, not the whole log: the remediation hint also says "symlink", so
    // matching the joined output would pass on any failure. This proves the actual reason reached the operator.
    expect(lines.find((l) => l.startsWith('CD automation failed:')) ?? '').toMatch(/symlink/i);
    expect(existsSync(join(outside, 'workflows'))).toBe(false); // nothing written outside the repo
  });
});

describe.each(workflows)('$templateName template drift guard', ({ templateKey, jobName }) => {
  it('retains the shipped manual, fail-closed, injection-safe workflow shape', () => {
    const template = readCdTemplate(resolveCdAutomationAssets()[templateKey]);
    const doc = parse(template) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, { 'runs-on'?: unknown; steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown>; if?: unknown; 'continue-on-error'?: unknown }> }>;
    };

    // This guard binds exactly the token-free, manual-only trigger, one-job runner, pinned tag checkout,
    // real unconditional fail-closed placeholder, unconditional later steps, and interpolation-free runs.
    // It is not exhaustive proof against every conceivable unsafe drift: for example, a release-capable
    // step inserted before the placeholder is outside this guard's scope.
    expect(template).not.toContain('__HEDDLE_');
    expect(Object.keys(doc.on ?? {})).toEqual(['workflow_dispatch']);
    expect(Object.keys(doc.jobs ?? {})).toEqual([jobName]);

    const job = doc.jobs?.[jobName];
    expect(job?.['runs-on']).toBe('ubuntu-24.04');
    const steps = job?.steps ?? [];
    const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.includes('actions/checkout'));
    expect(checkout?.with?.ref).toBe('refs/tags/${{ inputs.tag }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(checkout?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(template).toContain('uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');

    const placeholderIdx = steps.findIndex((step) => typeof step.run === 'string' && /^\s*exit 1\s*$/m.test(step.run));
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(steps[placeholderIdx]?.if).toBeUndefined();
    expect(steps[placeholderIdx]?.['continue-on-error']).toBeUndefined();
    steps.slice(placeholderIdx + 1).forEach((step) => {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    });
    steps.filter((step) => typeof step.run === 'string').forEach((step) => expect(step.run).not.toContain('${{'));
  });
});

describe('release-on-tag.yml.tmpl release-only drift guard', () => {
  it('keeps the verified tag release after the placeholder', () => {
    const template = readCdTemplate(resolveCdAutomationAssets().releaseTemplate);
    const doc = parse(template) as { jobs?: { release?: { steps?: Array<{ run?: string }> } } };
    const steps = doc.jobs?.release?.steps ?? [];
    const placeholderIdx = steps.findIndex((step) => typeof step.run === 'string' && /^\s*exit 1\s*$/m.test(step.run));
    const releaseIdx = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('gh release create'));

    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(placeholderIdx).toBeLessThan(releaseIdx);
    expect(steps[releaseIdx]?.run).toContain('--verify-tag');
    expect(steps[releaseIdx]?.run).not.toContain('${{');
  });
});
