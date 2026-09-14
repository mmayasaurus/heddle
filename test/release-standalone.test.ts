import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCleanMainHead, checkStandaloneOutput, releaseStandalone } from '../src/release/standalone.js';
import { isIncluded } from '../src/release/shipset.js';
import { useTempResources } from './helpers.js';

describe('regression PR#119 — standalone snapshot generator review findings', () => {
  const { tempDir } = useTempResources('heddle-standalone-');

  it('generates the CLI-only ship set deterministically', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    const one = releaseStandalone({ outDir: first, sourceDir: source });
    const two = releaseStandalone({ outDir: second, sourceDir: source });

    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    const included = [
      'src/cli.ts', 'docs/PROVIDER-MATRIX.md', 'skills/quality-gate.md',
      'assets/commands/startup.md', '.github/workflows/gate.yml',
      // the ratified hook-rule catalog + its shared fixtures ship so an installed heddle's
      // init-project chooser / resolveRulesRoot() fallback can find them (HED-535)
      'rules/no-rm-recursive-force.yaml', 'rules/tests/no-rm-recursive-force.jsonl',
    ];
    for (const path of included) {
      expect(existsSync(join(first, path))).toBe(true);
    }
    expect(readFileSync(join(first, 'LICENSE'), 'utf8'))
      .toContain('Copyright (c) 2026 Very Good Fiber Goods (' + 'VG' + 'FG)');
    const excluded = [
      'CLAUDE.md', '.claude', 'scripts', 'docs/fleet', '.github/workflows/deterministic-review.yml', 'AGENTS.md',
    ];
    for (const path of excluded) {
      expect(existsSync(join(first, path))).toBe(false);
    }
    const readme = readFileSync(join(first, 'README.md'), 'utf8');
    expect(readme).toContain('generated from the heddle source repository by `heddle release --standalone`');
    expect(readme).toContain('git clone <repository-url> && npm ci && npm run build');
    expect(readme).toContain('Replace `<repository-url>` with wherever the snapshot is published.');
    expect(readme).not.toContain('spin' + 'ventory');
    const release = JSON.parse(readFileSync(join(first, 'RELEASE.json'), 'utf8'));
    expect(release).toMatchObject({
      heddleVersion: expect.any(String), sourceCommit: expect.any(String), sourceRef: 'HEAD',
      generator: 'heddle release --standalone', shipSetHash: expect.any(String),
      scrubExemptions: ['LICENSE: copyright holder line (legal ownership; operator-approved)'],
    });
    expect(release.shipSetHash).toBe(JSON.parse(readFileSync(join(second, 'RELEASE.json'), 'utf8')).shipSetHash);
    expect(fileList(first)).toEqual(fileList(second));
  }, 120_000);

  it('rejects forbidden content and UI artifacts without touching the destination', () => {
    const root = tempDir();
    const destination = join(root, 'destination');
    writeFileSync(join(root, 'keep'), 'keep');
    const forbidden = snapshotSource(root, { 'test/forbidden.txt': 'spin' + 'ventory' });
    const ui = snapshotSource(tempDir(), { 'test/forbidden.tsx': 'export default null' });

    expect(releaseStandalone({ outDir: destination, sourceDir: forbidden })).toMatchObject({ ok: false });
    expect(releaseStandalone({ outDir: join(root, 'ui-output'), sourceDir: ui })).toMatchObject({ ok: false });
    expect(readFileSync(join(root, 'keep'), 'utf8')).toBe('keep');
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.tmp-${process.pid}`)).toBe(false);
    // Two snapshotSource builds (each archives the whole repo) — same heavy git work as the 120s
    // siblings above/below; the default 30s timeout flakes this one under parallel-suite load. — HED-507
  }, 120_000);

  it('rejects credential-shaped file names without touching the destination', () => {
    const root = tempDir();
    const destination = join(root, 'destination');
    const name = `test/${'g' + 'sk_'}${'a'.repeat(40)}.md`;
    const source = snapshotSource(root, { [name]: 'harmless contents' });

    const result = releaseStandalone({ outDir: destination, sourceDir: source });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('[path name carries a credential-shaped value]');
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${resolve(destination)}.tmp-${process.pid}`)).toBe(false);
  });

  it('allows only the LICENSE copyright holder line to contain the company identity', () => {
    const root = tempDir();
    const license = readFileSync('LICENSE', 'utf8');
    const company = 'VG' + 'FG';
    writeFileSync(join(root, 'LICENSE'), license);
    expect(checkStandaloneOutput(root)).toMatchObject({ ok: true });

    writeFileSync(join(root, 'LICENSE'), `${license}${company} elsewhere\n`);
    expect(checkStandaloneOutput(root)).toMatchObject({ ok: false });
    writeFileSync(join(root, 'LICENSE'), license);
    writeFileSync(join(root, 'notice.txt'), `${company} elsewhere\n`);
    expect(checkStandaloneOutput(root)).toMatchObject({ ok: false });
  });

  it('classifies Windows-style ship set paths using POSIX prefixes', () => {
    expect(isIncluded('src\\release\\standalone.ts')).toBe(true);
    expect(isIncluded('docs\\fleet\\dispatch.md')).toBe(false);
  });

  it('ships the ratified hook-rule catalog and its fixtures but not proposed experiments', () => {
    expect(isIncluded('rules/no-rm-recursive-force.yaml')).toBe(true);
    expect(isIncluded('rules/tests/no-rm-recursive-force.jsonl')).toBe(true);
    expect(isIncluded('rules/proposed/no-rm-recursive-force.yaml')).toBe(false);
  });

  it('records peeled commits for lightweight and annotated tags', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    execFileSync('git', ['tag', 'lightweight'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com',
      'tag', '-a', 'annotated', '-m', 'annotated'], { cwd: source });

    for (const tag of ['lightweight', 'annotated']) {
      const expected = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
        cwd: source, encoding: 'utf8',
      }).trim();
      const output = join(root, tag);
      const result = releaseStandalone({ outDir: output, sourceDir: source, sourceRef: tag });
      expect(result).toMatchObject({ ok: true, sourceCommit: expected });
      expect(JSON.parse(readFileSync(join(output, 'RELEASE.json'), 'utf8')).sourceCommit).toBe(expected);
    }
  });

  it('verifies a disposable copy without changing the shipped hash', () => {
    const root = tempDir();
    const bin = join(root, 'bin');
    const npm = join(bin, 'npm');
    const output = join(root, 'snapshot');
    mkdirSync(bin);
    writeFileSync(npm, [
      '#!/bin/sh',
      'mkdir -p node_modules',
      'if [ "$1" = "run" ]; then',
      '  mkdir -p dist',
      "  printf \"process.exit(process.argv.slice(2).join(' ') === 'classes --json' ? 0 : 1)\\n\" > dist/cli.js",
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(npm, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    try {
      const result = releaseStandalone({ outDir: output, sourceDir: snapshotSource(root), verify: true });
      const release = JSON.parse(readFileSync(join(output, 'RELEASE.json'), 'utf8')) as { shipSetHash: string };
      expect(result.ok).toBe(true);
      expect(existsSync(join(output, 'node_modules'))).toBe(false);
      expect(existsSync(join(output, 'dist'))).toBe(false);
      expect(snapshotHash(output)).toBe(release.shipSetHash);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('resolves relative destinations to the same absolute output path', () => {
    const absolute = join(tempDir(), 'snapshot');
    const relativeOutput = relative(process.cwd(), absolute);
    const source = snapshotSource(tempDir());

    expect(releaseStandalone({ outDir: relativeOutput, sourceDir: source }).ok).toBe(true);
    expect(releaseStandalone({ outDir: absolute, sourceDir: source })).toMatchObject({
      ok: false, error: `destination already exists: ${absolute}`,
    });
    expect(existsSync(absolute)).toBe(true);
  });

  it('treats a trailing slash destination as the same output path', () => {
    const output = join(tempDir(), 'snapshot');
    const source = snapshotSource(tempDir());

    expect(releaseStandalone({ outDir: `${output}/`, sourceDir: source }).ok).toBe(true);
    expect(releaseStandalone({ outDir: output, sourceDir: source })).toMatchObject({
      ok: false, error: `destination already exists: ${output}`,
    });
  });

  it('initializes one local snapshot commit without a remote', () => {
    const output = join(tempDir(), 'snapshot');
    const source = snapshotSource(tempDir());
    const result = releaseStandalone({ outDir: output, initGit: true, sourceDir: source });

    expect(result.ok).toBe(true);
    expect(execFileSync('git', ['-C', output, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('git', ['-C', output, 'remote'], { encoding: 'utf8' }).trim()).toBe('');
  }, 120_000);

  it('passes the output gate on an --init-git snapshot despite its .git store', () => {
    const output = join(tempDir(), 'snapshot');
    const source = snapshotSource(tempDir());
    expect(releaseStandalone({ outDir: output, initGit: true, sourceDir: source }).ok).toBe(true);
    expect(existsSync(join(output, '.git'))).toBe(true);
    expect(checkStandaloneOutput(output)).toMatchObject({ ok: true });
  }, 120_000);
});

describe('HED-507 — headless-first main-HEAD invariant', () => {
  const { tempDir } = useTempResources('heddle-standalone-invariant-');

  it("passes on a clean main HEAD and ships exactly main's tip commit", () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    const mainTip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: source, encoding: 'utf8' }).trim();

    const result = releaseStandalone({ outDir, sourceDir: source });

    expect(result.ok).toBe(true);
    expect(existsSync(outDir)).toBe(true);
    expect(result.sourceCommit).toBe(mainTip);
  });

  it('rejects a dirty working tree without touching the destination', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    writeFileSync(join(source, 'LICENSE'), `${readFileSync(join(source, 'LICENSE'), 'utf8')}\ndirty\n`);

    const result = releaseStandalone({ outDir, sourceDir: source });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/working tree is not clean/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it("rejects an ancestor of main (HEAD~1) — proves the gate is main's tip, not merely on main's history", () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    // second commit on main, so HEAD~1 is a real ancestor that IS on main's history but is not the tip
    writeFileSync(join(source, 'second.txt'), 'second\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second',
    ], { cwd: source });

    const result = releaseStandalone({ outDir, sourceDir: source, sourceRef: 'HEAD~1' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not main's HEAD/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects the default HEAD when checked out off main (a feature branch)', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: source });
    writeFileSync(join(source, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'feature commit',
    ], { cwd: source });

    // no sourceRef → defaults to HEAD, which is now the feature tip, not main's tip
    const result = releaseStandalone({ outDir, sourceDir: source });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not main's HEAD/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it('reports the dirty tree before the off-tip ref when a source is both', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: source });
    writeFileSync(join(source, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'feature commit',
    ], { cwd: source });
    // now also dirty the tree; both the dirty-tree and off-tip conditions hold
    writeFileSync(join(source, 'LICENSE'), `${readFileSync(join(source, 'LICENSE'), 'utf8')}\ndirty\n`);

    const result = releaseStandalone({ outDir, sourceDir: source });

    expect(result.ok).toBe(false);
    // dirty is checked before the ref/tip comparison — the operator-friendly order
    expect(result.error).toMatch(/working tree is not clean/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a source with no local main branch', () => {
    const root = tempDir();
    const source = join(root, 'source');
    const outDir = join(root, 'output');
    mkdirSync(source);
    execFileSync('git', ['init', '-q', '-b', 'other'], { cwd: source });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: source });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: source });
    writeFileSync(join(source, 'file.txt'), 'content\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial',
    ], { cwd: source });

    const result = releaseStandalone({ outDir, sourceDir: source });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no local 'main'/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it('cuts the artifact from sourceDir even when GIT_DIR points at another repo (hermetic git env)', () => {
    const root = tempDir();
    const source = snapshotSource(root);
    const outDir = join(root, 'output');
    const sourceTip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: source, encoding: 'utf8' }).trim();

    // a second, unrelated repo whose HEAD differs from sourceDir's tip
    const other = join(root, 'other');
    mkdirSync(other);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: other });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: other });
    writeFileSync(join(other, 'other.txt'), 'other\n');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'other',
    ], { cwd: other });
    const otherTip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: other, encoding: 'utf8' }).trim();
    expect(otherTip).not.toBe(sourceTip);

    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      const result = releaseStandalone({ outDir, sourceDir: source });
      expect(result.ok).toBe(true);
      // both the gate and the ship-set cut must honor sourceDir, not GIT_DIR
      expect(result.sourceCommit).toBe(sourceTip);
      expect(result.sourceCommit).not.toBe(otherTip);
      expect(existsSync(join(outDir, 'other.txt'))).toBe(false);
      expect(existsSync(join(outDir, 'src/cli.ts'))).toBe(true);
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
    }
  });

  it('returns the validated commit as an immutable SHA so the cut pins it (no re-resolution)', () => {
    // The gate resolves sourceRef -> a commit and proves it is main's tip; it now RETURNS that SHA so
    // generate archives the pinned object instead of re-resolving the mutable ref (the codeant/qodo
    // TOCTOU). This locks that contract: the returned commit is main's tip, as a full 40-hex SHA.
    const source = snapshotSource(tempDir());
    const mainTip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: source, encoding: 'utf8' }).trim();

    const result = assertCleanMainHead(source, 'HEAD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commit).toBe(mainTip);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

function fileList(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? fileList(root, path) : [path];
  }).sort();
}

function snapshotHash(root: string): string {
  const lines = fileList(root).filter((path) => path !== 'RELEASE.json').map((path) => (
    `${path}\n${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}`
  ));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function snapshotSource(root: string, additions: Record<string, string> = {}): string {
  const source = join(root, 'source');
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 });
  mkdirSync(source);
  const tar = join(root, 'source.tar');
  writeFileSync(tar, archive);
  execFileSync('tar', ['-xf', tar, '-C', source]);
  for (const path of ['.gitignore', 'LICENSE', 'SECURITY.md']) {
    writeFileSync(join(source, path), readFileSync(path));
  }
  for (const [path, contents] of Object.entries(additions)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), contents);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
  // Disable the detached `git maintenance run --auto` that `git commit` forks: it writes into .git
  // after the command returns and races the fixture's recursive teardown rm → ENOTEMPTY on
  // source/.git under CI load. maintenance.auto=false is the lever (gc.auto=0 alone does not stop the
  // detached fork — verified); persisted on the repo so the later add/commit/tag ops inherit it. — HED-520
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: source });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source',
  ], { cwd: source });
  return source;
}
