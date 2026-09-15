import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './persist.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';

export interface CdAutomationAssets {
  readonly releaseTemplate: string;
}

function bundledAssetsRoot(): string {
  return fileURLToPath(new URL('../../assets/pr-automation', import.meta.url));
}

export function resolveCdAutomationAssets(): CdAutomationAssets {
  return { releaseTemplate: join(bundledAssetsRoot(), 'release-on-tag.yml.tmpl') };
}

export function readCdTemplate(): string {
  return readFileSync(resolveCdAutomationAssets().releaseTemplate, 'utf8');
}

function releasePath(targetDir: string): string {
  return join(targetDir, '.github', 'workflows', 'release-on-tag.yml');
}

export function cdAutomationStep(): WizardStep {
  return {
    id: 'cd-automation',
    title: 'CD automation (release workflows)',
    applies: (ctx: WizardContext): boolean => !!ctx.targetDir && existsSync(join(ctx.targetDir, '.git')),
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (!ctx.targetDir) {
        io.report('CD automation skipped: no target project directory was selected.');
        return { id: 'cd-automation', status: 'skipped', summary: 'CD automation: no target directory' };
      }

      const path = releasePath(ctx.targetDir);
      if (ctx.dryRun) {
        io.report(`dry-run — CD automation: a real run would write ${path} (release-on-tag, manual workflow_dispatch only); nothing prompted or written.`);
        return {
          id: 'cd-automation',
          status: 'skipped',
          summary: 'dry-run — CD automation: release-on-tag manual workflow_dispatch write skipped',
        };
      }

      const add = await io.prompter.confirm('Add a CD release workflow (manually triggered: build + create a GitHub Release from a tag)?', false);
      if (!add) {
        io.report('CD automation: declined; no release workflow written.');
        return { id: 'cd-automation', status: 'skipped', summary: 'CD automation: release workflow declined' };
      }

      // The release template is static — it runs off the manually-entered tag, not a branch — so it is
      // written verbatim, with no __HEDDLE_ token substitution (unlike the CI templates, which are
      // preset-driven). A test asserts the template stays token-free; if a future edit introduces a
      // token, render it through renderWorkflow (pr-automation-step.ts) at that point.
      try {
        const written: string[] = [];
        const existing: string[] = [];
        if (existsSync(path)) {
          existing.push(path);
          io.report(`CD automation: already present — left unchanged: ${path}`);
        } else {
          atomicWriteFile(path, readCdTemplate());
          written.push(path);
          io.report(`CD automation: wrote ${path}`);
        }

        io.report('Next steps: this workflow is manual-dispatch-only. Edit its build-artifact step and configure protection for the release environment.');
        const changes = [
          written.length > 0 ? `wrote ${written.join(', ')}` : '',
          existing.length > 0 ? `already present ${existing.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return { id: 'cd-automation', status: 'done', summary: `CD automation: ${changes || 'no files changed'}` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        io.report(`CD automation failed: ${detail}`);
        return { id: 'cd-automation', status: 'failed', summary: 'CD automation: failed to write release workflow' };
      }
    },
  };
}
