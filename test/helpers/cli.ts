import { afterAll, afterEach } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBuilt, PROJECT_ROOT } from './build.js';

export { ensureBuilt, PROJECT_ROOT } from './build.js';
const tempHomes = new Set<string>();
const children = new Set<ChildProcess>();

export interface ChildOptions {
  home?: string;
  env?: Record<string, string>;
}

export interface CliOptions extends ChildOptions {
  stdin?: string;
}

function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  // Child commands open the default ledger, so inheriting HOME would make a test capable of changing
  // the operator's real history. USERPROFILE is Windows' home source, so both must point at the
  // temp home or startup's orphan sweep could mutate the operator's real ledger.
  return { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...extra };
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
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      children.delete(child);
      resolveRun({ stdout, stderr, code });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { stderr += error.message; finish(1); });
    child.once('close', (code) => finish(code ?? 1));
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
