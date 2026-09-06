import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { standaloneReadme } from './readme.js';
import { copyShipSet, extractShipSet } from './shipset.js';
import { credentialPatterns, licenseCopyrightExemption, scanFiles, scrubExemptions } from './scrub.js';

export type StandaloneOptions = {
  outDir: string; sourceRef?: string; initGit?: boolean; verify?: boolean; sourceDir?: string;
};
export type StandaloneResult = { ok: boolean; error?: string; sourceCommit?: string; shipSetHash?: string };

export function releaseStandalone(options: StandaloneOptions): StandaloneResult {
  const outDir = resolve(options.outDir);
  if (existsSync(outDir)) return { ok: false, error: `destination already exists: ${outDir}` };
  const tempDir = `${outDir}.tmp-${process.pid}`;
  if (existsSync(tempDir)) return { ok: false, error: `temporary destination already exists: ${tempDir}` };
  try {
    return generate(options, outDir, tempDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function generate(options: StandaloneOptions, outDir: string, tempDir: string): StandaloneResult {
  const sourceRef = options.sourceRef ?? 'HEAD';
  const extracted = extractShipSet(options.sourceDir ?? process.cwd(), sourceRef);
  try {
    copyShipSet(extracted.dir, tempDir);
    writeFileSync(join(tempDir, 'README.md'), standaloneReadme(version(tempDir), extracted.sourceCommit));
    const gate = checkStandaloneOutput(tempDir);
    if (!gate.ok) throw new Error(gate.issues.join('\n'));
    const shipSetHash = writeRelease(tempDir, extracted.sourceCommit, sourceRef);
    if (options.verify) verifySnapshot(tempDir);
    if (options.initGit) initializeGit(tempDir, extracted.sourceCommit);
    renameSync(tempDir, outDir);
    return { ok: true, sourceCommit: extracted.sourceCommit, shipSetHash };
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true });
  }
}

export function checkStandaloneOutput(root: string): { ok: boolean; issues: string[] } {
  const files = outputFiles(root).map((path) => ({ path, contents: readFileSync(join(root, path), 'utf8') }));
  const scrub = scanFiles(files, [licenseCopyrightExemption]);
  const credentialPaths = files
    .filter(({ path }) => credentialPatterns.some((pattern) => pattern.test(path)))
    .map(({ path }) => `${path}: [path name carries a credential-shaped value]`);
  const artifacts = files.map(({ path }) => path).filter(isUiArtifact).map((path) => `UI artifact: ${path}`);
  const directories = ['src-tauri', 'dashboard', 'ui', 'docs/fleet']
    .filter((path) => existsSync(join(root, path)));
  const directoryIssues = directories
    .map((path) => `${path === 'docs/fleet' ? 'forbidden directory' : 'UI artifact'}: ${path}/`);
  const issues = [...scrub.offendingLines, ...credentialPaths, ...artifacts, ...directoryIssues];
  return { ok: !issues.length, issues };
}

// Generated git internals and installed dependencies are not snapshot content: the release gate and
// hash run before `--init-git`, so skipping these is hash-neutral here, and it keeps the exported
// checker honest when a caller points it at a generated (`--init-git`) or post-`npm install` snapshot.
const excludedOutputDirs = new Set(['.git', 'node_modules']);

function outputFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedOutputDirs.has(entry.name)) return [];
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? outputFiles(root, path) : [path];
  });
}

function isUiArtifact(path: string): boolean {
  return /\.tsx$/.test(path) || path.startsWith('src-tauri/') || /^(dashboard|ui)(\/|$)/.test(path);
}

function version(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

function writeRelease(root: string, sourceCommit: string, sourceRef: string): string {
  const shipSetHash = hashShipSet(root);
  const release = {
    heddleVersion: version(root), sourceCommit, sourceRef,
    generator: 'heddle release --standalone', shipSetHash, scrubExemptions,
  };
  writeFileSync(join(root, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);
  return shipSetHash;
}

function hashShipSet(root: string): string {
  const lines = outputFiles(root).sort().map((path) => `${path}\n${hashFile(join(root, path))}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function initializeGit(root: string, sourceCommit: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=heddle', '-c', 'user.email=heddle@localhost',
    'commit', '-m', `heddle standalone snapshot ${sourceCommit}`,
  ], { cwd: root, stdio: 'ignore' });
}

function verifySnapshot(root: string): void {
  const verifyDir = `${root}.verify-${process.pid}`;
  if (existsSync(verifyDir)) throw new Error(`verification destination already exists: ${verifyDir}`);
  try {
    cpSync(root, verifyDir, { recursive: true });
    verifySnapshotCopy(verifyDir);
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

function verifySnapshotCopy(root: string): void {
  const steps = [
    { label: 'npm ci', command: 'npm', args: ['ci', '--ignore-scripts'] },
    { label: 'npm run build', command: 'npm', args: ['run', 'build'] },
    { label: 'node dist/cli.js classes --json', command: process.execPath, args: ['dist/cli.js', 'classes', '--json'] },
  ];
  for (const step of steps) {
    process.stderr.write(`verify: ${step.label}\n`);
    const result = spawnSync(step.command, step.args, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000,
    });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) throw new Error(`verification failed: ${step.label}`);
  }
}
