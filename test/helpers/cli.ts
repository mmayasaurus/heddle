import { afterAll, afterEach } from 'vitest';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempHomes = new Set<string>();
const children = new Set<ChildProcess>();
let build: Promise<void> | undefined;

export interface ChildOptions {
  home?: string;
  env?: Record<string, string>;
}

export interface CliOptions extends ChildOptions {
  stdin?: string;
}

function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  // Child commands open the default ledger, so inheriting HOME would make a test capable of changing
  // the operator's real history. Keep the environment deliberately narrow for repeatable results.
  return { PATH: process.env.PATH ?? '', HOME: home, ...extra };
}

export function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'heddle-cli-home-'));
  tempHomes.add(home);
  return home;
}

export function childEnv(opts: ChildOptions = {}): { home: string; env: Record<string, string> } {
  const home = opts.home ?? withTempHome();
  return { home, env: cleanEnv(home, opts.env) };
}

async function sourceIsNewerThan(path: string, builtAt: number): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (await sourceIsNewerThan(entryPath, builtAt)) return true;
    } else if (entry.isFile() && entry.name.endsWith('.ts') && (await stat(entryPath)).mtimeMs > builtAt) {
      return true;
    }
  }
  return false;
}

async function needsBuild(): Promise<boolean> {
  const cli = join(PROJECT_ROOT, 'dist', 'cli.js');
  try {
    const builtAt = (await stat(cli)).mtimeMs;
    return sourceIsNewerThan(join(PROJECT_ROOT, 'src'), builtAt);
  } catch {
    return true;
  }
}

function runTsc(): Promise<void> {
  const { env } = childEnv();
  return new Promise((resolveBuild, rejectBuild) => {
    const child = execFile(
      process.execPath,
      [join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')],
      { cwd: PROJECT_ROOT, env },
      (error, stdout, stderr) => {
        children.delete(child);
        if (error) {
          rejectBuild(new Error(
            `heddle test harness build failed (tsc):\n${stdout}\n${stderr}\n${error.message}`,
          ));
          return;
        }
        resolveBuild();
      },
    );
    children.add(child);
  });
}

export function ensureBuilt(): Promise<void> {
  // CI executes tests before its build step; checking every source avoids silently exercising an
  // old dist/ after an entrypoint change, while one promise prevents concurrent test files rebuilding.
  return (build ??= (async () => {
    if (await needsBuild()) await runTsc();
  })());
}

export async function runCli(
  args: string[],
  opts: CliOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  await ensureBuilt();
  const { env } = childEnv(opts);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/cli.js', ...args], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { stderr += error.message; });
    child.once('close', (code) => {
      children.delete(child);
      resolveRun({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(opts.stdin);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
  try { child.kill('SIGTERM'); } catch { /* A process can exit between the check and kill. */ }
  if (await Promise.race([exited.then(() => true), new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 1_000))])) return;
  try { child.kill('SIGKILL'); } catch { /* A process can exit between the timeout and escalation. */ }
  await exited;
}

async function cleanup(): Promise<void> {
  await Promise.all([...children].map(stop));
  children.clear();
  for (const home of tempHomes) rmSync(home, { recursive: true, force: true });
  tempHomes.clear();
}

afterEach(cleanup);
afterAll(cleanup);
