import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseStandalone } from '../src/release/standalone.js';
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
    const included = ['src/cli.ts', 'docs/PROVIDER-MATRIX.md', 'skills/quality-gate.md', '.github/workflows/gate.yml'];
    for (const path of included) {
      expect(existsSync(join(first, path))).toBe(true);
    }
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
  });

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
    writeFileSync(npm, '#!/bin/sh\nmkdir -p node_modules dist\nexit 0\n');
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

  it('initializes one local snapshot commit without a remote', () => {
    const output = join(tempDir(), 'snapshot');
    const source = snapshotSource(tempDir());
    const result = releaseStandalone({ outDir: output, initGit: true, sourceDir: source });

    expect(result.ok).toBe(true);
    expect(execFileSync('git', ['-C', output, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('git', ['-C', output, 'remote'], { encoding: 'utf8' }).trim()).toBe('');
  }, 120_000);
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
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'source',
  ], { cwd: source });
  return source;
}
