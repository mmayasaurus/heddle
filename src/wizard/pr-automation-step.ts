import { execFileSync } from 'node:child_process';
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

export const TS_NODE: Omit<RenderOptions, 'defaultBranch'> = {
  rulesets: ['p/typescript', 'p/nodejs'],
  inLangExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  excludes: ['node_modules', 'dist'],
  sourceGuaranteed: true,
};

export const GENERIC: Omit<RenderOptions, 'defaultBranch'> = {
  rulesets: ['p/default'],
  inLangExtensions: [],
  excludes: ['node_modules', 'dist'],
  sourceGuaranteed: false,
};

export interface PrAutomationAssets {
  readonly workflowTemplate: string;
  readonly gateTemplate: string;
  readonly gitleaksRangeScan: string;
}

// Single source of truth: the choice label IS the preset key, so `presetChoices` (shown to the operator)
// and `presetFor` (used to render) can never drift apart — renaming a label here updates both at once.
const PRESETS: Record<string, Omit<RenderOptions, 'defaultBranch'>> = { 'TS/Node': TS_NODE, 'Generic': GENERIC };
const presetChoices = Object.keys(PRESETS);
const nextSteps = [
  'What’s next:',
  '1. These scanners run on every PR automatically. To ENFORCE them as merge-blocking, add a repository ruleset requiring the `semgrep` and `gitleaks` check contexts — that’s a GitHub *settings* change (Settings → Rules), not a file this wizard can write.',
  '2. On a public repo, SARIF findings upload to GitHub code scanning automatically. On a private repo without GitHub Advanced Security that upload is skipped — expected, not an error; the scan findings still appear in each PR run’s job log and summary.',
  '3. To make CI merge-blocking, require the `gate` status check in a repository ruleset (Settings → Rules). With the Generic preset, edit its intentionally failing placeholder build job before requiring `gate`.',
  '4. Full CI review out-of-the-box; external AI reviewer apps (Codacy, CodeFactor, Cursor Bugbot, …) are a separate guided step.',
].join('\n');

// The templates under assets/pr-automation are VENDORED from heddle's own CI. `gitleaks-range-scan.sh`
// is `.github/scripts/gitleaks-range-scan.sh` copied BYTE-FOR-BYTE (a security artifact — do NOT hand-edit;
// re-sync from canonical; a test asserts byte-identity, so any drift reds). `deterministic-review.yml.tmpl`
// is `.github/workflows/deterministic-review.yml` with its language-coupled sites tokenized (`__HEDDLE_*__`)
// PLUS three deliberate additions over canonical — a re-syncer must NOT strip these as spurious drift:
//   (1) the identity scrub (tenant/operator names → "the first consumer project"/"the operator"; required
//       because a shipped file goes through public-scrub);
//   (2) the `__HEDDLE_SOURCE_GUARANTEED__` full-scan-zero guard (the generic preset warns rather than fails
//       when a repo has no source in the configured languages);
//   (3) per-upload `id:` + `continue-on-error: true` + the outcome-conditioned "Explain SARIF upload
//       availability" steps, so a private repo without code scanning degrades to the log + summary cleanly.
// `gate.yml.tmpl` is `.github/workflows/gate.yml` vendored the same way, with these deliberate divergences a
// re-syncer must NOT strip: the identity scrub; `__HEDDLE_DEFAULT_BRANCH__` (canonical hardcodes the push
// branch) and `__HEDDLE_GATE_BUILD_STEPS__` (canonical inlines heddle's own build; the template is
// preset-driven); and the verdict-echo's build selector NARROWED from canonical's `^(build|web|rust)` prefix
// (heddle has three build jobs) to an EXACT match on this template's single `build (…)` job name — a prefix
// would also capture unrelated `build*` jobs from other workflows on the same commit and corrupt the echo
// (qodo/codeant HED-616). A drift-guard test binds the selector to the job name.
function bundledAssetsRoot(): string {
  return fileURLToPath(new URL('../../assets/pr-automation', import.meta.url));
}

export function resolvePrAutomationAssets(): PrAutomationAssets {
  const root = bundledAssetsRoot();
  return {
    workflowTemplate: join(root, 'deterministic-review.yml.tmpl'),
    gateTemplate: join(root, 'gate.yml.tmpl'),
    gitleaksRangeScan: join(root, 'gitleaks-range-scan.sh'),
  };
}

export function readPrAutomationTemplates(): { readonly workflowTemplate: string; readonly gateTemplate: string; readonly gitleaksRangeScan: string } {
  const assets = resolvePrAutomationAssets();
  return {
    workflowTemplate: readFileSync(assets.workflowTemplate, 'utf8'),
    gateTemplate: readFileSync(assets.gateTemplate, 'utf8'),
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

function gateBuildSteps(options: RenderOptions): string {
  if (!options.sourceGuaranteed) {
    return [
      '      - name: Configure this build job',
      '        run: |',
      '          echo "::error::Configure the build job — edit .github/workflows/gate.yml to run your project\'s typecheck / test / build."',
      '          exit 1',
    ].join('\n');
  }
  // TS/Node preset assumes an npm project: `npm ci` requires a package-lock.json, and the typecheck/
  // test/build scripts must exist. A pnpm/yarn or differently-scripted repo edits these build steps (or
  // picks Generic) before requiring `gate` — the operator adapts the scaffold, as with the Generic
  // placeholder (see nextSteps; codeant HED-616).
  return [
    '      - name: Checkout',
    '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '        with:',
    '          persist-credentials: false',
    '',
    '      - name: Setup Node.js',
    '        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
    '        with:',
    '          node-version: 22',
    '          cache: npm',
    '',
    '      - name: Install dependencies',
    '        run: npm ci',
    '',
    '      - name: Type check',
    '        run: npm run typecheck',
    '',
    '      - name: Test',
    '        run: npm test',
    '',
    '      - name: Build',
    '        run: npm run build',
  ].join('\n');
}

// A git branch ref may legally contain characters that are hostile in the YAML and shell contexts the
// templates interpolate the branch into: `git check-ref-format` permits `"`, `$`, backtick, `,` and more —
// only a bare space (and a few structural sequences) are rejected. Constrain any branch that reaches a
// template to a conservative charset. detectDefaultBranch treats a name that fails this as undetectable
// (it falls through to the conventional-name lookup); renderWorkflow throws, so no caller — including the
// exported render helpers — can smuggle an unvetted value into a workflow (qodo/codeant, HED-616).
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function renderWorkflow(template: string, options: RenderOptions): string {
  if (!SAFE_BRANCH.test(options.defaultBranch)) {
    throw new Error(`workflow template default branch is not a safe ref name: ${JSON.stringify(options.defaultBranch)}`);
  }
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
    '__HEDDLE_GATE_BUILD_STEPS__': gateBuildSteps(options),
  };
  // Replace longer tokens FIRST: today no token is a substring of another (the `__` terminators keep
  // e.g. `__HEDDLE_RULESETS__` out of `__HEDDLE_RULESETS_DESCRIPTION__`), but sorting length-descending
  // makes that robust against any future token that IS a prefix of another, so a shorter token can never
  // partially resolve a longer one.
  const rendered = Object.entries(replacements)
    .sort(([a], [b]) => b.length - a.length)
    .reduce((current, [token, replacement]) => current.split(token).join(replacement), template);
  if (rendered.includes('__HEDDLE_')) throw new Error('workflow template contains an unresolved placeholder');
  return rendered;
}

type RenderPresetOptions = Omit<RenderOptions, 'defaultBranch'> & Partial<Pick<RenderOptions, 'defaultBranch'>>;

function withDefaultBranch(options: RenderPresetOptions): RenderOptions {
  return { ...options, defaultBranch: options.defaultBranch ?? 'main' };
}

export function renderDeterministicReview(options: RenderPresetOptions = TS_NODE): string {
  return renderWorkflow(readPrAutomationTemplates().workflowTemplate, withDefaultBranch(options));
}

export function renderGate(options: RenderPresetOptions = TS_NODE): string {
  return renderWorkflow(readPrAutomationTemplates().gateTemplate, withDefaultBranch(options));
}

export function detectDefaultBranch(targetDir: string): string {
  try {
    const remoteHead = execFileSync('git', ['-C', targetDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : '';
    // Accept origin/HEAD only when it names a charset-safe branch; a hostile name (or an unset/malformed
    // origin/HEAD) falls through to the conventional-name lookup rather than being interpolated verbatim.
    if (SAFE_BRANCH.test(branch)) return branch;
  } catch {
    // Try local conventional names below; a feature branch is deliberately not a fallback.
  }
  for (const branch of ['main', 'master']) {
    try {
      execFileSync('git', ['-C', targetDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
      return branch;
    } catch {
      // Check the next conventional branch name.
    }
  }
  return 'main';
}

function presetFor(choice: string): { readonly label: string; readonly options: Omit<RenderOptions, 'defaultBranch'> } {
  // Keyed on PRESETS so a label rename cannot misroute. Fall back to the first choice if the prompter ever
  // returns an unknown label (defensive — the shipped prompters only return a member of `presetChoices`).
  const label = choice in PRESETS ? choice : presetChoices[0];
  return { label, options: PRESETS[label] };
}

function targetPaths(targetDir: string): { readonly workflow: string; readonly gate: string; readonly gitleaks: string } {
  return {
    workflow: join(targetDir, '.github', 'workflows', 'deterministic-review.yml'),
    gate: join(targetDir, '.github', 'workflows', 'gate.yml'),
    gitleaks: join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh'),
  };
}

/**
 * Write all scaffold files into the target `.github/`, skipping (merge-preserving) any that already
 * exist. Returns which paths were written vs left unchanged so the caller can report and summarize.
 */
function scaffoldWorkflows(
  paths: { readonly workflow: string; readonly gate: string; readonly gitleaks: string },
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
  writeIfAbsent(paths.gate, renderWorkflow(templates.gateTemplate, options));
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
      const defaultBranch = detectDefaultBranch(ctx.targetDir);
      if (ctx.dryRun) {
        io.report(`dry-run — PR automation: a real run would write ${paths.workflow}, ${paths.gate}, and ${paths.gitleaks} using the TS/Node preset; detected default branch: ${defaultBranch}; nothing was prompted or written.`);
        return {
          id: 'pr-automation',
          status: 'skipped',
          summary: `dry-run — PR automation: TS/Node preset; detected default branch ${defaultBranch}; workflow, gate, and script write skipped`,
        };
      }

      const preset = presetFor(await io.prompter.select('Language preset', presetChoices));
      io.report(`PR automation language preset: ${preset.label}`);

      try {
        const { written, existing } = scaffoldWorkflows(paths, { ...preset.options, defaultBranch }, io);
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
