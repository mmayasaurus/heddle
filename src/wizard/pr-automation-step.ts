import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileWithinRoot } from '../secure-fs.js';
import { gitRepositoryFor } from '../worktree.js';
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
// it rejects space, `~`, `^`, `:`, `?`, `*`, `[`, backslash and control chars (plus structural sequences),
// yet the permitted set is still hostile here. Constrain any branch that reaches a
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
 * Write all scaffold files into the target `.github/`, skipping (merge-preserving) any that already exist.
 * `root` is the project repo (the trust boundary): each write is refused if a directory component below it
 * (`.github`, `workflows`, `scripts`) is a symlink or group/other-writable, so a scaffold can never escape the
 * chosen repo via a planted symlink (HED-650). Returns which paths were written vs left unchanged.
 */
function scaffoldWorkflows(
  root: string,
  paths: { readonly workflow: string; readonly gate: string; readonly gitleaks: string },
  options: RenderOptions,
  io: WizardIO,
): { written: string[]; existing: string[] } {
  const templates = readPrAutomationTemplates();
  const written: string[] = [];
  const existing: string[] = [];
  const writeIfAbsent = (path: string, content: string): void => {
    // createFileWithinRoot guards the `.github` chain below `root` and is create-only, so an existing file is
    // left unchanged (merge-preserving) and a symlinked component fails closed before any write.
    if (createFileWithinRoot(root, path, content) === 'exists') {
      existing.push(path);
      io.report(`PR automation: already present — left unchanged: ${path}`);
    } else {
      written.push(path);
      io.report(`PR automation: wrote ${path}`);
    }
  };
  writeIfAbsent(paths.workflow, renderWorkflow(templates.workflowTemplate, options));
  writeIfAbsent(paths.gate, renderWorkflow(templates.gateTemplate, options));
  writeIfAbsent(paths.gitleaks, templates.gitleaksRangeScan);
  return { written, existing };
}

// Expand a leading `~` / `~/` in an operator-entered path to the home directory before it reaches
// gitRepositoryFor — git runs relative to a real cwd and would treat a literal `~` as a directory name
// (path.resolve does not expand it either). HED-624 offer-to-add-repo.
function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * HED-624 offer-to-add-repo: when the wizard reaches PR automation with no project directory (setup ran
 * outside a repo, or an empty --target), offer to enter a git repository path — the operator's ask to "add a
 * repo if they haven't already, in case they started the wizard in the wrong place". Returns the resolved
 * repository toplevel, or a `skip` summary the caller turns into a skipped step result: dry-run discloses and
 * skips; a blank entry or three bad paths skip. Nothing is written either way.
 */
async function resolveTargetByOffer(ctx: WizardContext, io: WizardIO): Promise<{ dir: string } | { skip: string }> {
  if (ctx.dryRun) {
    io.report('dry-run — PR automation: no project repository selected; a real run would offer to enter a git repository path, then confirm before scaffolding CI review workflows. Nothing was prompted or written.');
    return { skip: 'dry-run — PR automation: no repository; a real run would offer a path, then confirm' };
  }
  // Validate each entry as a git repository with the SAME fail-safe helper cli.ts uses to auto-derive, so a
  // typed path is accepted identically to a detected one (and normalized to the repo toplevel, so .github/
  // lands at the root even if a subdirectory was entered; a leading ~ is expanded first). Re-prompt on a bad
  // path, capped at three attempts; a blank entry — or exhausting the cap — skips with nothing written.
  let entered = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const question = attempt === 0
      ? 'No project repository selected. Enter a path to the git repository to set up PR automation in (press Enter to skip):'
      : `Not a git repository: ${entered}. Enter a path to an existing git repository (Enter to skip):`;
    entered = (await io.prompter.text(question, '')).trim();
    if (!entered) return { skip: 'PR automation: no repository provided' };
    const resolved = gitRepositoryFor(expandHome(entered))?.topLevel;
    if (resolved) return { dir: resolved };
  }
  return { skip: 'PR automation: no git repository entered' };
}

export function prAutomationStep(): WizardStep {
  return {
    id: 'pr-automation',
    title: 'PR automation (CI review workflows)',
    // HED-624: with a target, apply only when it is a git repo — an explicit --target to a NON-repo dir
    // stays not-applicable (never scaffold into a directory the operator named that isn't a repo). With NO
    // target (undefined, or an empty --target), apply anyway so run() can OFFER to enter a repo path.
    applies: (ctx: WizardContext): boolean => !ctx.targetDir || existsSync(join(ctx.targetDir, '.git')),
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      // HED-624: when the operator resolves a repo at the offer prompt below (setup ran outside a repo),
      // publish it on EVERY result via selectedTargetDir so runSetup propagates it to ctx.targetDir for later
      // target-gated steps (cd-automation). Unset until the offer resolves — an explicit or auto-derived
      // --target is already on ctx, so it needs no republish; this covers only the offer-entered path. Declining
      // PR CI still publishes: the operator chose their project, and the downstream step confirms on its own.
      let offeredDir: string | undefined;
      const publish = (result: WizardStepResult): WizardStepResult => (offeredDir ? { ...result, selectedTargetDir: offeredDir } : result);
      const skip = (summary: string): WizardStepResult => publish({ id: 'pr-automation', status: 'skipped', summary });
      // needsConfirm keys on the ORIGINAL context, before the offer loop can set a target below: an explicit
      // --target (a real, non-derived targetDir) is the silent opt-in; a DERIVED target or one entered at the
      // offer prompt both confirm before writing (the operator's Option B — "detection or manual entry, the
      // confirm still gates the write"). A non-repo explicit --target never reaches run() (applies() filters it).
      const explicit = !!ctx.targetDir && !ctx.targetDirDerived;

      let targetDir = ctx.targetDir;
      if (!targetDir) {
        // HED-624 (offer-to-add-repo): reached with no project directory (setup ran outside a repo, or an
        // empty --target). resolveTargetByOffer owns that whole interaction — dry-run disclosure or the capped
        // path prompt — returning either a skip summary (flows straight out, nothing written) or the resolved
        // repo toplevel, which continues into the same confirm + scaffold path below.
        const offered = await resolveTargetByOffer(ctx, io);
        if ('skip' in offered) return skip(offered.skip);
        targetDir = offered.dir;
        offeredDir = offered.dir; // publish this repo downstream (see selectedTargetDir note above)
      }

      const paths = targetPaths(targetDir);
      const defaultBranch = detectDefaultBranch(targetDir);
      if (ctx.dryRun) {
        const detectedNote = ctx.targetDirDerived ? ' (auto-detected repository — a real run would confirm before writing)' : '';
        io.report(`dry-run — PR automation: a real run would write ${paths.workflow}, ${paths.gate}, and ${paths.gitleaks} using the TS/Node preset; detected default branch: ${defaultBranch}${detectedNote}; nothing was prompted or written.`);
        return skip(`dry-run — PR automation: TS/Node preset; detected default branch ${defaultBranch}; workflow, gate, and script write skipped${ctx.targetDirDerived ? ' (auto-detected repo, would confirm first)' : ''}`);
      }

      // HED-624 Option B: confirm before scaffolding into a target the operator did not explicitly name —
      // a repo we auto-detected OR one entered at the offer prompt. An explicit --target is the opt-in and
      // skips this; decline → nothing written. The detection disclosure is derived-only (a typed path needs
      // no "we found this" line — the operator just typed it).
      if (!explicit) {
        if (ctx.targetDirDerived) io.report(`Detected a git repository at ${targetDir}.`);
        const proceed = await io.prompter.confirm(`Set up PR automation (CI review workflows) in ${targetDir}/.github/?`, false);
        if (!proceed) return skip('PR automation: declined');
      }

      const preset = presetFor(await io.prompter.select('Language preset', presetChoices));
      io.report(`PR automation language preset: ${preset.label}`);

      try {
        const { written, existing } = scaffoldWorkflows(targetDir, paths, { ...preset.options, defaultBranch }, io);
        if (written.length > 0) io.report(nextSteps);
        const changes = [
          written.length > 0 ? `wrote ${written.join(', ')}` : '',
          existing.length > 0 ? `already present ${existing.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        return publish({
          id: 'pr-automation',
          status: 'done',
          summary: `PR automation: ${preset.label}; ${changes || 'no files changed'}`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        io.report(`PR automation failed: ${detail}`);
        if (/symlink|writable|not a directory/i.test(detail)) {
          io.report(`If ${targetDir}/.github is a symlink or world-writable, heddle will not write through it — replace it with a plain directory you own and re-run.`);
        }
        return publish({ id: 'pr-automation', status: 'failed', summary: `PR automation: ${preset.label}; failed to write workflows` });
      }
    },
  };
}
