import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './persist.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';

export interface RenderOptions {
  rulesets: string[];
  inLangExtensions: string[];
  excludes: string[];
  defaultBranch: string;
  /**
   * Whether the preset guarantees the target repo has source in the configured languages. When true, a
   * zero-target FULL scan (push to the default branch) fails closed — an empty scan means git broke. When
   * false (the generic preset — the repo may legitimately have no source in the configured languages), a
   * zero-target full scan warns instead of failing. Unreadable scanner output fails closed either way.
   */
  sourceGuaranteed: boolean;
}

export const TS_NODE: RenderOptions = {
  rulesets: ['p/typescript', 'p/nodejs'],
  inLangExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  excludes: ['node_modules', 'dist'],
  defaultBranch: 'main',
  sourceGuaranteed: true,
};

export const GENERIC: RenderOptions = {
  rulesets: ['p/default'],
  inLangExtensions: [],
  excludes: ['node_modules', 'dist'],
  defaultBranch: 'main',
  sourceGuaranteed: false,
};

export interface PrAutomationAssets {
  readonly workflowTemplate: string;
  readonly gitleaksRangeScan: string;
}

const presetChoices = ['TS/Node', 'Generic'] as const;
const nextSteps = [
  'What’s next:',
  '1. These scanners run on every PR automatically. To ENFORCE them as merge-blocking, add a repository ruleset requiring the `semgrep` and `gitleaks` check contexts — that’s a GitHub *settings* change (Settings → Rules), not a file this wizard can write.',
  '2. SARIF upload to code scanning skipped or failed — that needs a public repo or GitHub Advanced Security; the scan findings are in the job log + summary above.',
  '3. Full CI review out-of-the-box; external AI reviewer apps (Codacy, CodeFactor, Cursor Bugbot, …) are a separate guided step.',
].join('\n');

// The two templates under assets/pr-automation are VENDORED SECURITY ARTIFACTS, copied from heddle's own
// CI: `deterministic-review.yml.tmpl` is `.github/workflows/deterministic-review.yml` with only its
// language-coupled sites tokenized, and `gitleaks-range-scan.sh` is `.github/scripts/gitleaks-range-scan.sh`
// copied BYTE-FOR-BYTE. The gitleaks script's fail-closed guarantees were earned over many review rounds —
// do NOT hand-edit the vendored copy; re-sync it from heddle's canonical script. A test
// (`test/wizard/pr-automation-step.test.ts`) asserts the vendored script stays byte-identical to the
// canonical one, so any drift reds until it is re-synced.
function bundledAssetsRoot(): string {
  return fileURLToPath(new URL('../../assets/pr-automation', import.meta.url));
}

export function resolvePrAutomationAssets(): PrAutomationAssets {
  const root = bundledAssetsRoot();
  return {
    workflowTemplate: join(root, 'deterministic-review.yml.tmpl'),
    gitleaksRangeScan: join(root, 'gitleaks-range-scan.sh'),
  };
}

export function readPrAutomationTemplates(): { readonly workflowTemplate: string; readonly gitleaksRangeScan: string } {
  const assets = resolvePrAutomationAssets();
  return {
    workflowTemplate: readFileSync(assets.workflowTemplate, 'utf8'),
    gitleaksRangeScan: readFileSync(assets.gitleaksRangeScan, 'utf8'),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inLanguageRegex(extensions: readonly string[]): string {
  return extensions.length === 0 ? '.+' : `\\.(${extensions.map(escapeRegex).join('|')})$`;
}

function excludePathRegex(excludes: readonly string[]): string {
  return excludes.length === 0 ? 'a^' : `(^|/)(${excludes.map(escapeRegex).join('|')})/`;
}

function renderWorkflow(template: string, options: RenderOptions): string {
  const replacements: Record<string, string> = {
    '__HEDDLE_RULESETS__': options.rulesets.map((ruleset) => `--config ${ruleset}`).join(' '),
    '__HEDDLE_RULESETS_DESCRIPTION__': options.rulesets.join(' + '),
    '__HEDDLE_INLANG_EXTENSION_REGEX__': inLanguageRegex(options.inLangExtensions),
    '__HEDDLE_INLANG_EXTENSIONS_DESCRIPTION__': options.inLangExtensions.length === 0
      ? 'all non-excluded changed paths (generic fallback)'
      : options.inLangExtensions.join(' '),
    '__HEDDLE_EXCLUDES_ARGS__': options.excludes.map((exclude) => `--exclude ${exclude}`).join(' '),
    '__HEDDLE_EXCLUDES_DESCRIPTION__': options.excludes.join(' / '),
    '__HEDDLE_EXCLUDES_PATH_REGEX__': excludePathRegex(options.excludes),
    '__HEDDLE_DEFAULT_BRANCH__': options.defaultBranch,
    '__HEDDLE_SOURCE_GUARANTEED__': options.sourceGuaranteed ? 'yes' : '',
  };
  // Replace longer tokens FIRST: today no token is a substring of another (the `__` terminators keep
  // e.g. `__HEDDLE_RULESETS__` out of `__HEDDLE_RULESETS_DESCRIPTION__`), but sorting length-descending
  // makes that robust against any future token that IS a prefix of another, so a shorter token can never
  // partially resolve a longer one.
  const rendered = Object.entries(replacements)
    .sort(([a], [b]) => b.length - a.length)
    .reduce((current, [token, replacement]) => current.split(token).join(replacement), template);
  if (rendered.includes('__HEDDLE_')) throw new Error('deterministic-review template contains an unresolved placeholder');
  return rendered;
}

export function renderDeterministicReview(options: RenderOptions = TS_NODE): string {
  return renderWorkflow(readPrAutomationTemplates().workflowTemplate, options);
}

function presetFor(choice: string): { readonly label: string; readonly options: RenderOptions } {
  return choice === 'Generic'
    ? { label: 'Generic', options: GENERIC }
    : { label: 'TS/Node', options: TS_NODE };
}

function targetPaths(targetDir: string): { readonly workflow: string; readonly gitleaks: string } {
  return {
    workflow: join(targetDir, '.github', 'workflows', 'deterministic-review.yml'),
    gitleaks: join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh'),
  };
}

/**
 * Write both scaffold files into the target `.github/`, skipping (merge-preserving) any that already
 * exist. Returns which paths were written vs left unchanged so the caller can report and summarize.
 */
function scaffoldWorkflows(
  paths: { readonly workflow: string; readonly gitleaks: string },
  options: RenderOptions,
  io: WizardIO,
): { written: string[]; existing: string[] } {
  const templates = readPrAutomationTemplates();
  const written: string[] = [];
  const existing: string[] = [];
  const writeIfAbsent = (path: string, content: string): void => {
    if (existsSync(path)) {
      existing.push(path);
      io.report(`PR automation: already present — left unchanged: ${path}`);
    } else {
      atomicWriteFile(path, content);
      written.push(path);
      io.report(`PR automation: wrote ${path}`);
    }
  };
  writeIfAbsent(paths.workflow, renderWorkflow(templates.workflowTemplate, options));
  writeIfAbsent(paths.gitleaks, templates.gitleaksRangeScan);
  return { written, existing };
}

export function prAutomationStep(): WizardStep {
  return {
    id: 'pr-automation',
    title: 'PR automation (CI review workflows)',
    applies: (ctx: WizardContext): boolean => !!ctx.targetDir && existsSync(join(ctx.targetDir, '.git')),
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      if (!ctx.targetDir) {
        io.report('PR automation skipped: no target project directory was selected.');
        return { id: 'pr-automation', status: 'skipped', summary: 'PR automation: no target directory' };
      }

      const paths = targetPaths(ctx.targetDir);
      if (ctx.dryRun) {
        io.report(`dry-run — PR automation: a real run would write ${paths.workflow} and ${paths.gitleaks} using the TS/Node preset; nothing was prompted or written.`);
        return {
          id: 'pr-automation',
          status: 'skipped',
          summary: 'dry-run — PR automation: TS/Node preset; workflow and script write skipped',
        };
      }

      const preset = presetFor(await io.prompter.select('Language preset', presetChoices));
      io.report(`PR automation language preset: ${preset.label}`);

      try {
        const { written, existing } = scaffoldWorkflows(paths, preset.options, io);
        if (written.length > 0) io.report(nextSteps);
        const changes = [
          written.length > 0 ? `wrote ${written.join(', ')}` : '',
          existing.length > 0 ? `already present ${existing.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return {
          id: 'pr-automation',
          status: 'done',
          summary: `PR automation: ${preset.label}; ${changes || 'no files changed'}`,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        io.report(`PR automation failed: ${detail}`);
        return { id: 'pr-automation', status: 'failed', summary: `PR automation: ${preset.label}; failed to write workflows` };
      }
    },
  };
}
