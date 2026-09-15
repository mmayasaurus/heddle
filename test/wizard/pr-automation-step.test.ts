import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GENERIC, TS_NODE, detectDefaultBranch, prAutomationStep, readPrAutomationTemplates, renderDeterministicReview, renderGate, resolvePrAutomationAssets } from '../../src/wizard/pr-automation-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

function context(targetDir: string | undefined, dryRun = false, targetDirDerived = false): WizardContext {
  return { homeDir: targetDir ?? '/unused', targetDir, targetDirDerived, dryRun, now: () => new Date(), results: new Map() };
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
    const gate = readFileSync(join(targetDir, '.github', 'workflows', 'gate.yml'), 'utf8');
    const script = readFileSync(join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh'));
    const sourceScript = readFileSync(resolvePrAutomationAssets().gitleaksRangeScan);

    expect(result.status).toBe('done');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toMatch(/container:\n(?:.*\n)*?\s+image: .+@sha256:/);
    expect(workflow).toContain('--metrics=off');
    expect(script.equals(sourceScript)).toBe(true);
    expect(gate).toContain('name: build');
  });

  it('keeps the vendored gitleaks script byte-identical to heddle’s canonical script (drift guard)', () => {
    // The vendored asset is a security artifact; if heddle's canonical scanner script changes, this reds
    // until the vendored copy is re-synced (R, HED-597). import.meta-relative so it is cwd-independent.
    const vendored = readFileSync(resolvePrAutomationAssets().gitleaksRangeScan);
    const canonical = readFileSync(fileURLToPath(new URL('../../.github/scripts/gitleaks-range-scan.sh', import.meta.url)));
    expect(vendored.equals(canonical)).toBe(true);
  });

  it('routes the Generic preset choice through run() to the written workflow (not just renderDeterministicReview)', async () => {
    // Drives the real prompt → presetFor → scaffold path so a future preset-label/keys drift is caught,
    // not only the direct render helper (adversarial review, HED-597).
    const targetDir = targetRepo(tempDir);
    const result = await prAutomationStep().run(context(targetDir), io(['Generic']));
    const workflow = readFileSync(join(targetDir, '.github', 'workflows', 'deterministic-review.yml'), 'utf8');
    expect(result.status).toBe('done');
    expect(workflow).toContain('--config p/default');
    expect(workflow).not.toContain('p/typescript');
  });

  it('keeps all language-coupled rendering sites in sync for the generic preset', () => {
    const tsNode = renderDeterministicReview(TS_NODE);
    const generic = renderDeterministicReview(GENERIC);

    expect(tsNode).toContain('--config p/typescript --config p/nodejs');
    expect(generic).toContain('--config p/default');
    expect(generic).not.toContain('p/typescript');
    expect(generic).toContain("grep -cE '.+'");
    expect(generic).toContain("grep -vE '(^|/)(node_modules|dist)/'");
    expect(generic).toContain('branches: ["main"]');
    // sourceGuaranteed also moves: TS/Node fails a 0-target full scan; generic warns instead.
    expect(tsNode).toContain('[ -n "yes" ]');
    expect(generic).toContain('[ -n "" ]');
    expect(generic).not.toContain('__HEDDLE_');
  });

  it('renders valid portable gate YAML for both presets and keeps its echo aligned with build', () => {
    for (const [preset, defaultBranch] of [[TS_NODE, 'trunk'], [GENERIC, 'main']] as const) {
      const gate = renderGate({ ...preset, defaultBranch });
      const document = parse(gate) as { jobs: { build: { name: string }; gate: { steps: Array<{ run?: string }> } } };
      const echo = document.jobs.gate.steps.find((step) => step.run)?.run ?? '';
      const nameSelects = [...echo.matchAll(/\.name == "([^"]+)"/g)].map((match) => match[1]);
      const buildName = document.jobs.build.name;

      // The echo selects the build check-runs by this workflow's EXACT build job name — not a `^build`
      // prefix, which would also match unrelated `build*` jobs from other workflows on the same commit
      // and corrupt the four-state logic (qodo/codeant HED-616). BOTH coupled selects (the $leaf
      // max-started_at select AND the INFLIGHT count select) must key on it: an asymmetric drift reads
      // 0-in-flight and fails the gate closed while the build still runs. The one other .name select is
      // the gate-verdict marker lookup.
      expect(nameSelects.filter((name) => name === buildName)).toHaveLength(2);
      expect(nameSelects.filter((name) => name === 'gate-verdict')).toHaveLength(1);
      expect(new Set(nameSelects)).toEqual(new Set([buildName, 'gate-verdict']));
      execFileSync('sh', ['-n'], { input: echo });
    }
  });

  it('uses a failing placeholder build for Generic and standard Node commands for TS/Node', () => {
    expect(renderGate({ ...GENERIC, defaultBranch: 'main' })).toContain('exit 1');
    const gate = renderGate({ ...TS_NODE, defaultBranch: 'main' });
    expect(gate).toContain('npm ci');
    expect(gate).toContain('npm run typecheck');
    expect(gate).toContain('npm test');
    expect(gate).toContain('npm run build');
  });

  it('detects origin HEAD, main, master, and the main fallback without using the current branch', () => {
    const initRepo = (): string => {
      const target = tempDir();
      execFileSync('git', ['init', '-q', target]);
      return target;
    };
    const commit = (target: string): void => {
      execFileSync('git', ['-C', target, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
    };
    const origin = tempDir();
    execFileSync('git', ['init', '--bare', '-q', origin]);
    const seed = initRepo();
    execFileSync('git', ['-C', seed, 'checkout', '-q', '-b', 'trunk']);
    commit(seed);
    execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin]);
    execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'trunk']);
    execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    const originHead = tempDir();
    execFileSync('git', ['clone', '-q', origin, originHead]);
    const main = initRepo();
    execFileSync('git', ['-C', main, 'checkout', '-q', '-b', 'main']);
    commit(main);
    // Move OFF main so a correct 'main' result can only come from the show-ref lookup — never the
    // current branch (a feature branch is deliberately never a fallback).
    execFileSync('git', ['-C', main, 'checkout', '-q', '-b', 'work']);
    const master = initRepo();
    execFileSync('git', ['-C', master, 'checkout', '-q', '-b', 'master']);
    commit(master);
    const fallback = initRepo();
    execFileSync('git', ['-C', fallback, 'checkout', '-q', '-b', 'feature-only']);
    commit(fallback);
    execFileSync('git', ['-C', fallback, 'checkout', '-q', '--detach']);
    // A charset-hostile origin/HEAD (git permits `$`, `"`, backtick, … in a ref — it rejects space, `~`,
    // `^`, `:`, `?`, `*`, `[`, backslash and control chars, but the permitted set is still hostile here)
    // must never be interpolated into a workflow — detection falls through to the
    // conventional-name lookup, then the 'main' default (qodo/codeant HED-616 sanitization). Set the
    // ref directly rather than via push/clone: it drives the exact symbolic-ref read detection uses and
    // keeps this git-heavy integration test fast.
    const hostileHead = initRepo();
    execFileSync('git', ['-C', hostileHead, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/foo$bar']);

    expect(detectDefaultBranch(originHead)).toBe('trunk');
    expect(detectDefaultBranch(main)).toBe('main');
    expect(detectDefaultBranch(master)).toBe('master');
    expect(detectDefaultBranch(fallback)).toBe('main');
    // origin/HEAD resolves to the hostile name, but it is rejected and never returned.
    expect(detectDefaultBranch(hostileHead)).toBe('main');
  }, 60000);

  it('conditions the SARIF explain note on an actual upload failure, not always()', () => {
    const workflow = renderDeterministicReview(TS_NODE);
    // The explanatory note must fire only when an upload really failed — never on success or a
    // fork/main skip (qodo/cursor: an always() note falsely claims every run was skipped/failed).
    expect(workflow).toContain("steps.semgrep_sarif_upload.outcome == 'failure'");
    expect(workflow).toContain("steps.gitleaks_sarif_upload.outcome == 'failure'");
    expect(workflow).not.toContain('SARIF upload to code scanning skipped or failed');
  });

  it('makes all three code-scanning uploads non-blocking', () => {
    expect(renderDeterministicReview(TS_NODE).match(/continue-on-error: true/g)).toHaveLength(3);
  });

  it('preserves an existing target file and reports it', async () => {
    const targetDir = targetRepo(tempDir);
    const workflowPath = join(targetDir, '.github', 'workflows', 'deterministic-review.yml');
    const gatePath = join(targetDir, '.github', 'workflows', 'gate.yml');
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(workflowPath, 'operator workflow\n');
    writeFileSync(gatePath, 'operator gate\n');
    const lines: string[] = [];

    await prAutomationStep().run(context(targetDir), io(['TS/Node'], lines));

    expect(readFileSync(workflowPath, 'utf8')).toBe('operator workflow\n');
    expect(readFileSync(gatePath, 'utf8')).toBe('operator gate\n');
    expect(lines.some((line) => line.includes(`already present — left unchanged: ${workflowPath}`))).toBe(true);
    expect(lines.some((line) => line.includes(`already present — left unchanged: ${gatePath}`))).toBe(true);
  });

  it('reports resolved paths and writes nothing during dry-run', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await prAutomationStep().run(context(targetDir, true), io([], lines));
    const workflowPath = join(targetDir, '.github', 'workflows', 'deterministic-review.yml');
    const scriptPath = join(targetDir, '.github', 'scripts', 'gitleaks-range-scan.sh');
    const gatePath = join(targetDir, '.github', 'workflows', 'gate.yml');

    expect(result.status).toBe('skipped');
    expect(existsSync(workflowPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
    expect(existsSync(gatePath)).toBe(false);
    expect(lines.join('\n')).toContain(workflowPath);
    expect(lines.join('\n')).toContain(scriptPath);
    expect(lines.join('\n')).toContain(gatePath);
    expect(lines.join('\n')).toContain('detected default branch: main');
  });

  it('applies to a git-repo target, offers when there is no target, stays out of a non-repo target (HED-624 three-way)', () => {
    const targetDir = tempDir();
    // No target (undefined OR an empty --target): applies so run() can OFFER to enter a repo path.
    expect(prAutomationStep().applies?.(context(undefined))).toBe(true);
    expect(prAutomationStep().applies?.(context(''))).toBe(true);
    // An explicit target that is NOT a git repo stays not-applicable — never scaffold into a named non-repo dir.
    expect(prAutomationStep().applies?.(context(targetDir))).toBe(false);
    // A git-repo target applies.
    mkdirSync(join(targetDir, '.git'));
    expect(prAutomationStep().applies?.(context(targetDir))).toBe(true);
  });

  it('resolves and reads the package-root bundled templates', () => {
    const assets = resolvePrAutomationAssets();
    const templates = readPrAutomationTemplates();

    expect(existsSync(assets.workflowTemplate)).toBe(true);
    expect(existsSync(assets.gitleaksRangeScan)).toBe(true);
    expect(existsSync(assets.gateTemplate)).toBe(true);
    expect(templates.workflowTemplate).toContain('Deterministic Review');
    expect(templates.gitleaksRangeScan).toContain('set -eu');
    expect(templates.gateTemplate).toContain('__HEDDLE_GATE_BUILD_STEPS__');
  });

  // ---- HED-624: confirm-first when the target was AUTO-DETECTED from cwd (targetDirDerived) -----------
  // An explicit --target stays silent (covered by every test above, which passes targetDirDerived=false and
  // never scripts a leading confirm answer — a confirm firing there would throw on the non-boolean preset).
  it('auto-detected target: declining the confirm skips without writing anything (HED-624)', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await prAutomationStep().run(context(targetDir, false, true), io([false], lines));
    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('PR automation: declined');
    expect(existsSync(join(targetDir, '.github', 'workflows', 'deterministic-review.yml'))).toBe(false);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'gate.yml'))).toBe(false);
    // Derived target → the confirm is preceded by the detection disclosure (a manually-entered path is not).
    expect(lines.some((line) => line.includes(`Detected a git repository at ${targetDir}`))).toBe(true);
  });

  it('auto-detected target: accepting the confirm scaffolds as normal (HED-624)', async () => {
    const targetDir = targetRepo(tempDir);
    const result = await prAutomationStep().run(context(targetDir, false, true), io([true, 'TS/Node']));
    expect(result.status).toBe('done');
    expect(existsSync(join(targetDir, '.github', 'workflows', 'deterministic-review.yml'))).toBe(true);
    expect(existsSync(join(targetDir, '.github', 'workflows', 'gate.yml'))).toBe(true);
  });

  it('auto-detected target dry-run: discloses it would confirm first, writes nothing (HED-624)', async () => {
    const targetDir = targetRepo(tempDir);
    const lines: string[] = [];
    const result = await prAutomationStep().run(context(targetDir, true, true), io([], lines));
    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('auto-detected repo, would confirm first');
    expect(lines.join('\n')).toContain('a real run would confirm before writing');
    expect(existsSync(join(targetDir, '.github', 'workflows', 'deterministic-review.yml'))).toBe(false);
  });

  // ---- HED-624: offer-to-add-repo when the wizard reached PR automation with NO target -----------------
  // applies() now returns true without a target so run() OFFERS a repo path; each entry is validated with the
  // same gitRepositoryFor helper cli.ts uses to auto-derive (real `git init` repos here, not a bare .git dir).
  it('no target + dry-run: discloses it would offer a path then confirm, prompts and writes nothing (HED-624)', async () => {
    const lines: string[] = [];
    // io([]) scripts ZERO answers — a fired prompt would throw "answer script exhausted", so this also proves
    // the dry-run path never prompts.
    const result = await prAutomationStep().run(context(undefined, true), io([], lines));
    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('a real run would offer a path, then confirm');
    expect(lines.join('\n')).toContain('a real run would offer to enter a git repository path');
  });

  it('no target: a blank entry at the offer prompt skips with nothing written (HED-624)', async () => {
    const result = await prAutomationStep().run(context(undefined), io(['']));
    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('PR automation: no repository provided');
  });

  it('no target: three non-repo entries exhaust the retry cap and skip (HED-624)', async () => {
    const notRepo = tempDir();
    // Exactly three answers: a fourth attempt would throw "answer script exhausted", so a clean cap-skip here
    // proves the loop stops at three.
    const result = await prAutomationStep().run(context(undefined), io([notRepo, notRepo, notRepo]));
    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('PR automation: no git repository entered');
  });

  it('no target: a bad path then a real repo reaches the confirm; declining writes nothing but still publishes the chosen repo (HED-624)', async () => {
    const notRepo = tempDir();
    const repo = tempDir();
    execFileSync('git', ['init', '-q', repo]);
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const result = await prAutomationStep().run(context(undefined), io([notRepo, repo, false]));
    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('PR automation: declined');
    expect(existsSync(join(repo, '.github', 'workflows', 'gate.yml'))).toBe(false);
    // Declining PR CI still publishes the repo the operator chose, so a later step (cd-automation) acts on it.
    expect(result.selectedTargetDir).toBe(toplevel);
  });

  it('no target: entering a SUBDIRECTORY normalizes to the repo toplevel and scaffolds there on confirm (HED-624)', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q', repo]);
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const subdir = join(repo, 'packages', 'app');
    mkdirSync(subdir, { recursive: true });
    const result = await prAutomationStep().run(context(undefined), io([subdir, true, 'TS/Node']));
    expect(result.status).toBe('done');
    // .github lands at the repo TOPLEVEL, not under the entered subdirectory (gitRepositoryFor normalization).
    expect(existsSync(join(toplevel, '.github', 'workflows', 'gate.yml'))).toBe(true);
    expect(existsSync(join(subdir, '.github'))).toBe(false);
    // The published target is the normalized repo TOPLEVEL (not the entered subdirectory) — what a later
    // target-gated step (cd-automation) then receives via runSetup.
    expect(result.selectedTargetDir).toBe(toplevel);
  });

  it('renderGate throws (fail-closed) on a defaultBranch that fails SAFE_BRANCH (HED-616)', () => {
    // The fail-closed throw added in 10ee703 was left unasserted — detection never returns a failing value
    // and the presets default to 'main', so nothing pinned it. Pin it here (X, HED-616 review rider).
    expect(() => renderGate({ ...TS_NODE, defaultBranch: 'foo"bar' })).toThrow(/not a safe ref name/);
  });
});
