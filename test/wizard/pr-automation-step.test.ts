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
    // A charset-hostile origin/HEAD (git allows `$`, `"`, backtick, … in a ref; only a bare space is
    // rejected) must never be interpolated into a workflow — detection falls through to the
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
    expect(existsSync(assets.gateTemplate)).toBe(true);
    expect(templates.workflowTemplate).toContain('Deterministic Review');
    expect(templates.gitleaksRangeScan).toContain('set -eu');
    expect(templates.gateTemplate).toContain('__HEDDLE_GATE_BUILD_STEPS__');
  });
});
