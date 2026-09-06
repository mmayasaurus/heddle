import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseStandalone } from '../src/release/standalone.js';
import { useTempResources } from './helpers.js';

describe('heddle release --standalone', () => {
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
