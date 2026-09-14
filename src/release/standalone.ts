import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { standaloneReadme } from './readme.js';
import { copyShipSet, extractShipSet } from './shipset.js';
import { credentialPatterns, licenseCopyrightExemption, scanFiles, scrubExemptions } from './scrub.js';
import { gitEnv } from './git-env.js';

export type StandaloneOptions = {
  outDir: string; sourceRef?: string; initGit?: boolean; verify?: boolean; sourceDir?: string;
};
export type StandaloneResult = { ok: boolean; error?: string; sourceCommit?: string; shipSetHash?: string };

export function releaseStandalone(options: StandaloneOptions): StandaloneResult {
  // The invariant is about the SOURCE, so it gates first: a stale outDir/tempDir must not mask an
  // off-main or dirty source (HED-507 review F5). Nothing below depends on this order.
  const invariant = assertCleanMainHead(options.sourceDir ?? process.cwd(), options.sourceRef ?? 'HEAD');
  if (!invariant.ok) return { ok: false, error: invariant.error };
  const outDir = resolve(options.outDir);
  if (existsSync(outDir)) return { ok: false, error: `destination already exists: ${outDir}` };
  const tempDir = `${outDir}.tmp-${process.pid}`;
  if (existsSync(tempDir)) return { ok: false, error: `temporary destination already exists: ${tempDir}` };
  try {
    return generate(options, outDir, tempDir, invariant.commit);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// The headless-first invariant (HED-507, docs/ARCHITECTURE.md#headless-first-invariant): a standalone
// artifact must be cut from a clean checkout whose source ref is main's current HEAD — not merely an
// ancestor of main. An ancestor (e.g. `--source-ref main~3` or a merged side branch) would ship a tree
// that diverges from the source of truth while looking legitimate, which is exactly what this prevents.
export function assertCleanMainHead(
  sourceDir: string,
  sourceRef: string,
): { ok: true; commit: string } | { ok: false; error: string } {
  const git = (args: string[]) => spawnSync('git', args, { cwd: sourceDir, encoding: 'utf8', env: gitEnv() });
  const mainRef = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
  if (mainRef.status !== 0) {
    return { ok: false, error: "release: the source has no local 'main' branch — the standalone must be cut from a clean main checkout (headless-first invariant, HED-507; docs/ARCHITECTURE.md#headless-first-invariant)" };
  }
  const mainHead = (mainRef.stdout ?? '').trim();
  const porcelain = git(['status', '--porcelain']);
  if (porcelain.status !== 0) {
    return { ok: false, error: 'release: could not read the source working-tree status (not a git checkout?) — the standalone must be cut from a clean main checkout (headless-first invariant, HED-507)' };
  }
  if ((porcelain.stdout ?? '').trim() !== '') {
    return { ok: false, error: 'release: the source working tree is not clean — commit or stash changes; the standalone must be cut from a clean main checkout (headless-first invariant, HED-507)' };
  }
  const rev = git(['rev-parse', '--verify', `${sourceRef}^{commit}`]);
  if (rev.status !== 0) {
    return { ok: false, error: `release: could not resolve source ref '${sourceRef}' (headless-first invariant, HED-507)` };
  }
  const commit = (rev.stdout ?? '').trim();
  if (commit !== mainHead) {
    return { ok: false, error: `release: source commit ${commit.slice(0, 12)} is not main's HEAD ${mainHead.slice(0, 12)} — check out main and pull (headless-first invariant, HED-507)` };
  }
  return { ok: true, commit };
}

function generate(options: StandaloneOptions, outDir: string, tempDir: string, sourceCommit: string): StandaloneResult {
  // sourceCommit is the immutable SHA the invariant gate resolved and proved to be main's tip
  // (assertCleanMainHead). We cut from — and record — that exact pin, never a re-resolution of the
  // mutable source ref: extractShipSet archives the pin, and every commit we write (README, RELEASE.json,
  // the --init-git snapshot, the result) is the pin itself, so there is no second resolution to drift
  // between validation and the cut (HED-507 review: codeant/qodo TOCTOU). sourceRef is kept only as the
  // human-facing label in RELEASE.json.
  const sourceRef = options.sourceRef ?? 'HEAD';
  const extracted = extractShipSet(options.sourceDir ?? process.cwd(), sourceCommit);
  try {
    copyShipSet(extracted.dir, tempDir);
    writeFileSync(join(tempDir, 'README.md'), standaloneReadme(version(tempDir), sourceCommit));
    const gate = checkStandaloneOutput(tempDir);
    if (!gate.ok) throw new Error(gate.issues.join('\n'));
    const shipSetHash = writeRelease(tempDir, sourceCommit, sourceRef);
    if (options.verify) verifySnapshot(tempDir);
    if (options.initGit) initializeGit(tempDir, sourceCommit);
    renameSync(tempDir, outDir);
    return { ok: true, sourceCommit, shipSetHash };
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
  const env = gitEnv();
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore', env });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore', env });
  execFileSync('git', [
    '-c', 'user.name=heddle', '-c', 'user.email=heddle@localhost',
    'commit', '-m', `heddle standalone snapshot ${sourceCommit}`,
  ], { cwd: root, stdio: 'ignore', env });
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
