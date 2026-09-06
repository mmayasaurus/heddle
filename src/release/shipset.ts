import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const rootFiles = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts', '.gitignore',
  'LICENSE', 'SECURITY.md',
]);

export function extractShipSet(sourceDir: string, sourceRef: string): { dir: string; sourceCommit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-standalone-source-'));
  const archive = execFileSync('git', ['archive', '--format=tar', sourceRef], {
    cwd: sourceDir, maxBuffer: 64 * 1024 * 1024,
  });
  const tarPath = join(dir, 'source.tar');
  writeFileSync(tarPath, archive);
  execFileSync('tar', ['-xf', tarPath, '-C', dir]);
  const sourceCommit = execFileSync('git', ['rev-parse', `${sourceRef}^{commit}`], {
    cwd: sourceDir, encoding: 'utf8',
  }).trim();
  return { dir, sourceCommit };
}

export function copyShipSet(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  files(source).filter(isIncluded).forEach((path) => copyFile(source, destination, path));
  rewritePackage(join(destination, 'package.json'));
}

export function isIncluded(path: string): boolean {
  path = toPosixPath(path);
  return rootFiles.has(path) || path.startsWith('src/') || path.startsWith('test/') || path.startsWith('routing/')
    || path.startsWith('skills/') || (path.startsWith('docs/') && !path.startsWith('docs/fleet/'))
    || path === '.github/workflows/gate.yml';
}

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = toPosixPath(join(prefix, entry.name));
    return entry.isDirectory() ? files(root, path) : [path];
  });
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/').replaceAll('\\', '/');
}

function copyFile(source: string, destination: string, path: string): void {
  const to = join(destination, path);
  mkdirSync(join(to, '..'), { recursive: true });
  cpSync(join(source, path), to);
}

function rewritePackage(path: string): void {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete pkg.private;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
