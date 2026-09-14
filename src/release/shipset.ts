import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { gitEnv } from './git-env.js';

const rootFiles = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts', '.gitignore',
  'LICENSE', 'SECURITY.md',
]);

// `commit` is the immutable SHA the release gate already resolved and validated (assertCleanMainHead).
// We archive that exact object rather than a symbolic ref, and we do NOT re-derive it here: the caller
// records the pin it passed in, so the shipped tree and the recorded commit are the same validated
// object with no second resolution that could drift (HED-507 review: codeant/qodo TOCTOU).
// `git archive <sha>` emits that commit's committed tree.
export function extractShipSet(sourceDir: string, commit: string): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-standalone-source-'));
  const archive = execFileSync('git', ['archive', '--format=tar', commit], {
    cwd: sourceDir, maxBuffer: 64 * 1024 * 1024, env: gitEnv(),
  });
  const tarPath = join(dir, 'source.tar');
  writeFileSync(tarPath, archive);
  execFileSync('tar', ['-xf', tarPath, '-C', dir]);
  return { dir };
}

export function copyShipSet(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  files(source).filter(isIncluded).forEach((path) => copyFile(source, destination, path));
  rewritePackage(join(destination, 'package.json'));
}

export function isIncluded(path: string): boolean {
  path = toPosixPath(path);
  return rootFiles.has(path) || path.startsWith('src/') || path.startsWith('test/') || path.startsWith('routing/')
    || path.startsWith('skills/') || path.startsWith('assets/')
    || (path.startsWith('docs/') && !path.startsWith('docs/fleet/'))
    // The ratified hook-rule catalog is the bundled fallback the init-project chooser and
    // resolveRulesRoot() read from (src/rules/lifecycle.ts); a release must carry it or the catalog is
    // invisible in an installed heddle. Ship active rules + shared fixtures, never rules/proposed/ —
    // un-ratified experiments that loadRules() ignores anyway.
    || (path.startsWith('rules/') && !path.startsWith('rules/proposed/'))
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
