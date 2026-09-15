import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './persist.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';

export interface CdAutomationAssets {
  readonly releaseTemplate: string;
  readonly publishTemplate: string;
  readonly deployTemplate: string;
}

interface CdWorkflow {
  readonly outputName: string;
  readonly template: (assets: CdAutomationAssets) => string;
  readonly prompt: string;
  readonly environment: string;
}

interface AppliedCdWorkflow {
  readonly path: string;
  readonly environment: string;
}

interface CdWorkflowChanges {
  readonly written: AppliedCdWorkflow[];
  readonly existing: AppliedCdWorkflow[];
  readonly declined: string[];
}

function bundledAssetsRoot(): string {
  return fileURLToPath(new URL('../../assets/pr-automation', import.meta.url));
}

export function resolveCdAutomationAssets(): CdAutomationAssets {
  const root = bundledAssetsRoot();
  return {
    releaseTemplate: join(root, 'release-on-tag.yml.tmpl'),
    publishTemplate: join(root, 'publish.yml.tmpl'),
    deployTemplate: join(root, 'deploy.yml.tmpl'),
  };
}

export function readCdTemplate(templateFile: string): string {
  return readFileSync(templateFile, 'utf8');
}

const workflows: readonly CdWorkflow[] = [
  {
    outputName: 'release-on-tag.yml',
    template: (assets) => assets.releaseTemplate,
    prompt: 'Add a release workflow (manually triggered: build + create a GitHub Release from a tag)?',
    environment: 'release',
  },
  {
    outputName: 'publish.yml',
    template: (assets) => assets.publishTemplate,
    prompt: 'Add a package-publish workflow (manually triggered: build + publish a package from a tag)?',
    environment: 'publish',
  },
  {
    outputName: 'deploy.yml',
    template: (assets) => assets.deployTemplate,
    prompt: 'Add a deploy workflow (manually triggered: deploy a tagged release)?',
    environment: 'production',
  },
];

function workflowPath(targetDir: string, outputName: string): string {
  return join(targetDir, '.github', 'workflows', outputName);
}

async function applyCdWorkflows(targetDir: string, io: WizardIO, assets: CdAutomationAssets): Promise<CdWorkflowChanges> {
  const written: AppliedCdWorkflow[] = [];
  const existing: AppliedCdWorkflow[] = [];
  const declined: string[] = [];

  for (const workflow of workflows) {
    const path = workflowPath(targetDir, workflow.outputName);
    const add = await io.prompter.confirm(workflow.prompt, false);
    if (!add) {
      declined.push(path);
    } else if (existsSync(path)) {
      existing.push({ path, environment: workflow.environment });
      io.report(`CD automation: already present — left unchanged: ${path}`);
    } else {
      atomicWriteFile(path, readCdTemplate(workflow.template(assets)));
      written.push({ path, environment: workflow.environment });
      io.report(`CD automation: wrote ${path}`);
    }
  }

  return { written, existing, declined };
}

function reportCdNextSteps(io: WizardIO, written: readonly AppliedCdWorkflow[], existing: readonly AppliedCdWorkflow[]): void {
  if (written.length > 0) {
    io.report(`Next steps: heddle wrote these manual-dispatch-only workflows — edit each one's build/publish/deploy step: ${written.map(({ path }) => path).join(', ')}. Protect the ${written.map(({ environment }) => environment).join(', ')} environment(s) with required reviewers; heddle configures no environment protection itself.`);
  }
  if (existing.length > 0) {
    io.report(`Note: these workflow files already existed and were left unchanged — heddle did not read or validate them: ${existing.map(({ path }) => path).join(', ')}. Review each one's triggers, permissions, checkout ref, and environment before relying on it.`);
  }
}

function summarizeCd(written: readonly AppliedCdWorkflow[], existing: readonly AppliedCdWorkflow[], declined: readonly string[]): string {
  const changes = [
    written.length > 0 ? `wrote ${written.map(({ path }) => path).join(', ')}` : '',
    existing.length > 0 ? `already present ${existing.map(({ path }) => path).join(', ')}` : '',
    declined.length > 0 ? `declined ${declined.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `CD automation: ${changes || 'no files changed'}`;
}

export function cdAutomationStep(): WizardStep {
  return {
    id: 'cd-automation',
    title: 'CD automation (release / publish / deploy workflows)',
    applies: (ctx: WizardContext): boolean => !!ctx.targetDir && existsSync(join(ctx.targetDir, '.git')),
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (!ctx.targetDir) {
        io.report('CD automation skipped: no target project directory was selected.');
        return { id: 'cd-automation', status: 'skipped', summary: 'CD automation: no target directory' };
      }

      const paths = workflows.map((workflow) => workflowPath(ctx.targetDir!, workflow.outputName));
      if (ctx.dryRun) {
        io.report(`dry-run — CD automation: a real run would offer to write ${paths.join(', ')} (each manual workflow_dispatch only); nothing prompted or written.`);
        return { id: 'cd-automation', status: 'skipped', summary: 'dry-run — CD automation: workflow_dispatch writes skipped' };
      }

      const proceed = await io.prompter.confirm('Set up CD workflows (release / package-publish / deploy)? Each is opt-in next, manually triggered, and safe by default.', false);
      if (!proceed) {
        io.report('CD automation: declined; no workflows written.');
        return { id: 'cd-automation', status: 'skipped', summary: 'CD automation: declined' };
      }

      try {
        const changes = await applyCdWorkflows(ctx.targetDir, io, resolveCdAutomationAssets());
        reportCdNextSteps(io, changes.written, changes.existing);
        return { id: 'cd-automation', status: 'done', summary: summarizeCd(changes.written, changes.existing, changes.declined) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        io.report(`CD automation failed: ${detail}`);
        return { id: 'cd-automation', status: 'failed', summary: 'CD automation: failed to write a workflow' };
      }
    },
  };
}
