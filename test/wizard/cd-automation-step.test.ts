import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('cdAutomationStep', () => {
  const { tempDir } = useTempResources('hed603-cd-automation-');

  it('reports the release path and writes nothing during dry-run', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await cdAutomationStep().run(context(targetDir, true), io([], lines));
    const releasePath = join(targetDir, '.github', 'workflows', 'release-on-tag.yml');

    expect(result.status).toBe('skipped');
    expect(existsSync(releasePath)).toBe(false);
    expect(result.summary).toContain('dry-run');
    expect(lines.join('\n')).toContain(releasePath);
    expect(lines.join('\n')).toContain('workflow_dispatch');
  });

  it('skips when no target directory was selected', async () => {
    const result = await cdAutomationStep().run(context(undefined), io([]));

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('no target directory');
  });

  it('leaves the target unchanged when the operator declines', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await cdAutomationStep().run(context(targetDir), io([false]));
    const releasePath = join(targetDir, '.github', 'workflows', 'release-on-tag.yml');

    expect(result.status).toBe('skipped');
    expect(existsSync(releasePath)).toBe(false);
  });

  it('writes the manual release workflow after opt-in', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await cdAutomationStep().run(context(targetDir), io([true]));
    const releasePath = join(targetDir, '.github', 'workflows', 'release-on-tag.yml');

    expect(result.status).toBe('done');
    expect(readFileSync(releasePath, 'utf8')).toBe(readCdTemplate());
  });

  it('preserves an existing release workflow and reports it', async () => {
    const targetDir = targetRepo(tempDir);
    const releasePath = join(targetDir, '.github', 'workflows', 'release-on-tag.yml');
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(releasePath, 'operator workflow\n');
    const lines: string[] = [];

    const result = await cdAutomationStep().run(context(targetDir), io([true], lines));

    expect(result.status).toBe('done');
    expect(readFileSync(releasePath, 'utf8')).toBe('operator workflow\n');
    expect(lines.some((line) => line.includes(`already present — left unchanged: ${releasePath}`))).toBe(true);
  });

  it('release template is valid YAML: manual-dispatch-only, fail-closed, injection-safe, token-free (drift guard)', () => {
    const template = readCdTemplate();
    // Written verbatim — no __HEDDLE_ substitution. If a token is ever added this reddens; wire the
    // write through renderWorkflow (pr-automation-step.ts) at that point.
    expect(template).not.toContain('__HEDDLE_');

    // Parse with the same yaml@2 lib pr-automation-step.test uses. This catches invalid YAML (a workflow
    // that would not load on GitHub) AND lets us assert the safety shape structurally, not by substring.
    const doc = parse(template) as {
      on?: Record<string, unknown>;
      jobs?: {
        release?: {
          'runs-on'?: unknown;
          steps?: Array<{ name?: string; run?: string; uses?: string; with?: { ref?: unknown }; if?: unknown; 'continue-on-error'?: unknown }>;
        };
      };
    };

    // Manual-dispatch ONLY — no push / tags / schedule / release / pull_request / repository_dispatch /
    // workflow_run trigger can ever ship a release unattended.
    expect(Object.keys(doc.on ?? {})).toEqual(['workflow_dispatch']);

    // Runner pinned to a fixed image (matches the sibling gate/deterministic-review templates) — a rarely
    // run release job must not silently change when GitHub retargets `-latest`.
    expect(doc.jobs?.release?.['runs-on']).toBe('ubuntu-24.04');

    const steps = doc.jobs?.release?.steps ?? [];
    // Fail-closed, bound STRUCTURALLY so a future drift edit that breaks it reddens (not just a surface
    // substring check): a fresh, unconfigured scaffold cannot reach `gh release create` on first dispatch.
    // (1) The placeholder is a real `exit 1` LINE — `/^\s*exit 1\s*$/m` rejects a defanged `echo "exit 1"`.
    const placeholderIdx = steps.findIndex((step) => typeof step.run === 'string' && /^\s*exit 1\s*$/m.test(step.run));
    const releaseIdx = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('gh release create'));
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    // (2) The failing build precedes the release, so the release step's implicit `if: success()` is false
    //     after it fails (a reorder that put the release first would run it unconditionally).
    expect(placeholderIdx).toBeLessThan(releaseIdx);
    // (3) The placeholder's own failure is not swallowed — `continue-on-error: true` here would flip the
    //     job back to success and let the release run.
    expect(steps[placeholderIdx]?.['continue-on-error']).toBeUndefined();

    const releaseStep = steps[releaseIdx];
    // The release step itself does not bypass a failed build via if:/continue-on-error either.
    expect(releaseStep?.if).toBeUndefined();
    expect(releaseStep?.['continue-on-error']).toBeUndefined();
    // Injection-safe: the dispatch input is routed through env:, never interpolated into the run: shell.
    expect(releaseStep?.run).not.toContain('${{');
    // --verify-tag: gh fails if the tag does not already exist, so a release can never be created at the
    // default-branch tip from a non-tag/nonexistent ref (qodo HIGH + cursor "wrong commit").
    expect(releaseStep?.run).toContain('--verify-tag');

    // Checkout pins the TAG ref (refs/tags/…), so a branch name / commit SHA / nonexistent input fails at
    // checkout — the release can only ever build the commit the named tag points at (an unqualified ref
    // resolves a same-named branch first, diverging the built commit from the released one).
    const checkoutStep = steps.find((step) => typeof step.uses === 'string' && step.uses.includes('actions/checkout'));
    expect(checkoutStep?.with?.ref).toBe('refs/tags/${{ inputs.tag }}');
  });

  it('only applies to a target repository root and resolves its bundled template', () => {
    const targetDir = tempDir();
    const assets = resolveCdAutomationAssets();

    expect(cdAutomationStep().applies?.(context(undefined))).toBe(false);
    expect(cdAutomationStep().applies?.(context(targetDir))).toBe(false);
    mkdirSync(join(targetDir, '.git'));
    expect(cdAutomationStep().applies?.(context(targetDir))).toBe(true);
    expect(existsSync(assets.releaseTemplate)).toBe(true);
  });
});
