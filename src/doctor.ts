import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadLanes } from './lanes.js';
import { PROVIDER_REGISTRY } from './adapters/openai-compat.js';
import { DEFAULT_ACCOUNTS_PATH, readClaudeAccounts } from './capaware.js';
import { DEFAULT_PROJECTS_PATH, loadProjectRegistry } from './projects.js';
import { listTaskClasses, loadRouting, resolveRoute, type RouteTarget } from './routing.js';

export type CheckOutcome = 'ok' | 'warn' | 'fail' | 'skipped';
export interface CheckResult {
  id: string;
  kind: 'binary' | 'login' | 'catalog' | 'config' | 'freshness';
  provider?: string;
  outcome: CheckOutcome;
  detail: string;
  hint?: string;
}
export interface DoctorReport {
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number; skipped: number };
  exitCode: 0 | 1;
}
export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  execFile: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut?: boolean }>;
  now: () => Date;
  paths: { routing?: string; lanes?: string; projects?: string; accounts?: string };
}

type Provider = 'claude' | 'codex' | 'cursor' | 'gemini';
interface Harness { provider: Provider; cli: string; installHint: string; loginHint?: string; login?: string[]; catalog?: string[]; }
interface Definition { id: string; kind: CheckResult['kind']; provider?: string; run: () => Promise<Omit<CheckResult, 'id' | 'kind' | 'provider'>>; }

const harnesses: readonly Harness[] = [
  // Verified 2026-08-28: `claude auth status --help` lists `--json` and describes authentication status.
  { provider: 'claude', cli: 'claude', installHint: 'install Claude Code, then run claude /login', loginHint: 'claude /login', login: ['auth', 'status', '--json'] },
  // Verified 2026-08-28: `codex login --help` lists `status` as “Show login status”.
  { provider: 'codex', cli: 'codex', installHint: 'install Codex CLI, then run codex login', loginHint: 'codex login', login: ['login', 'status'] },
  // Verified 2026-08-28: `cursor-agent status --help` lists `--format json`; `cursor-agent models --help` lists available models.
  { provider: 'cursor', cli: 'cursor-agent', installHint: 'install Cursor Agent, then run cursor-agent login', loginHint: 'cursor-agent login', login: ['status', '--format', 'json'], catalog: ['models'] },
  // Verified 2026-08-28: `agy --help` has no login-status subcommand; `agy models --help` says “List available models”.
  { provider: 'gemini', cli: 'agy', installHint: 'install Antigravity CLI and authenticate interactively', catalog: ['models'] },
];

function defaultExecFile(cmd: string, args: string[], opts: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

function result(outcome: CheckOutcome, detail: string, hint?: string): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  const sanitized = detail.trim().replace(/[\r\n]+/g, '; ').replace(/[ \t]+/g, ' ').slice(0, 240);
  return hint ? { outcome, detail: sanitized, hint } : { outcome, detail: sanitized };
}

function textError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function loggedIn(stdout: string, stderr: string, code: number | null): boolean | undefined {
  if (code !== 0) return false;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ['loggedIn', 'isAuthenticated', 'authenticated']) {
      if (typeof parsed[key] === 'boolean') return parsed[key];
    }
    if (parsed.status === 'authenticated') return true;
    if (parsed.status === 'unauthenticated') return false;
  } catch { /* Some verified status commands use text. */ }
  // Text-form probes may report on EITHER stream: codex prints `Logged in using ChatGPT` on stderr
  // with an empty stdout (verified 2026-08-28, codex-cli 0.147.0).
  const text = `${stdout}\n${stderr}`.trim();
  if (/^logged in/i.test(text)) return true;
  if (/not logged in|logged out|unauthenticated/i.test(text)) return false;
  return undefined;
}

function catalogModels(stdout: string): Set<string> {
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') values.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  try { walk(JSON.parse(stdout)); } catch { /* Plain-text catalogs are checked line-by-line below. */ }
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candidates = [
      trimmed.split(' - ', 1)[0],
      trimmed.split('\t', 1)[0],
      trimmed.split(/\s+/, 1)[0],
    ];
    for (const candidate of candidates) {
      if (/^[a-z][a-z0-9._-]*$/.test(candidate)) values.add(candidate);
    }
  }
  return values;
}

function timeoutResult(cli: string, timeoutMs: number): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  return result('warn', `timed out after ${timeoutMs / 1_000}s — unverified, not proven broken`, `re-run; if it persists see docs/LANDMINES.md (${cli})`);
}

function targetModels(provider: Provider, routingPath?: string): Array<{ taskClass: string; model: string }> {
  const routing = loadRouting(routingPath);
  const targets: Array<{ taskClass: string; model: string }> = [];
  for (const taskClass of listTaskClasses(routing)) {
    const route = resolveRoute(routing, taskClass);
    for (const target of [route, route.fallback].filter(Boolean) as RouteTarget[]) {
      if (target.provider === provider) targets.push({ taskClass, model: target.model });
    }
  }
  return targets;
}

export async function runDoctor(opts: { provider?: string }, partial: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const deps: DoctorDeps = {
    env: partial.env ?? process.env,
    execFile: partial.execFile ?? defaultExecFile,
    now: partial.now ?? (() => new Date()),
    paths: partial.paths ?? {},
  };
  const selected = new Set(harnesses.filter((h) => !opts.provider || h.provider === opts.provider).map((h) => h.provider));
  const binaryMissing = new Set<Provider>();
  const definitions: Definition[] = [];

  for (const harness of harnesses) {
    if (!selected.has(harness.provider)) continue;
    definitions.push({ id: `binary:${harness.provider}`, kind: 'binary', provider: harness.provider, run: async () => {
      try {
        const probe = await deps.execFile(harness.cli, ['--version'], { timeoutMs: 5_000 });
        if (probe.timedOut) return timeoutResult(harness.cli, 5_000);
        if (probe.code !== 0) return result('fail', probe.stderr || `${harness.cli} --version exited ${probe.code}`, harness.installHint);
        return result('ok', probe.stdout.trim() || `${harness.cli} installed`);
      } catch (error) {
        if (isMissingBinary(error)) binaryMissing.add(harness.provider);
        return result('fail', textError(error), harness.installHint);
      }
    } });
    definitions.push({ id: `login:${harness.provider}`, kind: 'login', provider: harness.provider, run: async () => {
      if (binaryMissing.has(harness.provider)) return result('skipped', 'binary missing');
      if (!harness.login) return result('skipped', `no login probe verified for ${harness.cli}`);
      const probe = await deps.execFile(harness.cli, harness.login, { timeoutMs: 15_000 });
      if (probe.timedOut) return timeoutResult(harness.cli, 15_000);
      const status = loggedIn(probe.stdout, probe.stderr, probe.code);
      if (status === undefined) return result('warn', 'unrecognized status output');
      return status ? result('ok', 'logged in') : result('fail', 'logged out', harness.loginHint);
    } });
    definitions.push({ id: `catalog:${harness.provider}`, kind: 'catalog', provider: harness.provider, run: async () => {
      if (binaryMissing.has(harness.provider)) return result('skipped', 'binary missing');
      if (!harness.catalog) return result('skipped', `no catalog command verified for ${harness.cli}`);
      const targets = targetModels(harness.provider, deps.paths.routing);
      if (targets.length === 0) return result('skipped', `no routed models for ${harness.provider}`);
      const probe = await deps.execFile(harness.cli, harness.catalog, { timeoutMs: 20_000 });
      if (probe.timedOut) return timeoutResult(harness.cli, 20_000);
      if (probe.code !== 0) return result('fail', probe.stderr || `${harness.cli} ${harness.catalog.join(' ')} exited ${probe.code}`);
      const models = catalogModels(probe.stdout);
      const absent = targets.filter((target) => !models.has(target.model));
      return absent.length === 0
        ? result('ok', `${targets.length} routed model${targets.length === 1 ? '' : 's'} present`)
        : result('fail', absent.map((target) => `${target.taskClass}: ${target.model}`).join('; '), 'update the routing model or choose an available catalog model');
    } });
  }

  definitions.push({ id: 'config:routing', kind: 'config', run: async () => {
    const routing = loadRouting(deps.paths.routing);
    for (const taskClass of listTaskClasses(routing)) resolveRoute(routing, taskClass);
    return result('ok', `${listTaskClasses(routing).length} task classes resolve`);
  } });
  definitions.push({ id: 'config:lanes', kind: 'config', run: async () => {
    loadLanes(deps.paths.lanes);
    return result('ok', 'lanes.yaml parses');
  } });
  definitions.push({ id: 'config:projects', kind: 'config', run: async () => {
    const path = deps.paths.projects ?? DEFAULT_PROJECTS_PATH;
    const registry = loadProjectRegistry(path);
    return !existsSync(path)
      ? result('ok', 'absent; consumers fall back to cwd inference')
      : result('ok', `${registry.projects.length} project${registry.projects.length === 1 ? '' : 's'} registered`);
  } });
  definitions.push({ id: 'config:claude-accounts', kind: 'config', run: async () => {
    const path = deps.paths.accounts ?? DEFAULT_ACCOUNTS_PATH;
    const accounts = readClaudeAccounts(path);
    if (!existsSync(path)) return result('warn', 'no Claude account registry; headless claude workers use the inherited login');
    const loggedInCount = accounts.filter((account) => account.loggedIn !== false).length;
    return result('ok', `${accounts.length} Claude account${accounts.length === 1 ? '' : 's'}; ${loggedInCount} logged in`);
  } });

  for (const [provider, config] of Object.entries(PROVIDER_REGISTRY) as Array<[keyof typeof PROVIDER_REGISTRY, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]]>) {
    if (opts.provider && opts.provider !== provider) continue;
    definitions.push({ id: `freshness:${provider}`, kind: 'freshness', provider, run: async () => {
      const maxDays = loadLanes(deps.paths.lanes).floors.menial_verify_days;
      const days = Math.floor((deps.now().getTime() - new Date(config.lastVerified).getTime()) / 86_400_000);
      const freshness = days > maxDays ? `last verified ${days} days ago (> ${maxDays})` : `last verified ${days} days ago`;
      const present = Boolean(deps.env[config.keyEnv]);
      return result(days > maxDays || !present ? 'warn' : 'ok', `${freshness}; ${config.keyEnv}: ${present ? 'present' : 'absent'}`);
    } });
  }

  const checks: CheckResult[] = [];
  for (const definition of definitions) {
    try {
      checks.push({ id: definition.id, kind: definition.kind, ...(definition.provider ? { provider: definition.provider } : {}), ...await definition.run() });
    } catch (error) {
      checks.push({ id: definition.id, kind: definition.kind, ...(definition.provider ? { provider: definition.provider } : {}), ...result('fail', textError(error)) });
    }
  }
  const summary = checks.reduce((counts, entry) => ({ ...counts, [entry.outcome]: counts[entry.outcome] + 1 }), { ok: 0, warn: 0, fail: 0, skipped: 0 });
  return { checks, summary, exitCode: summary.fail ? 1 : 0 };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map((check) => `${check.outcome.padEnd(7)} ${check.kind.padEnd(10)} ${(check.provider ?? 'global').padEnd(10)} ${check.detail}${check.hint ? ` — ${check.hint}` : ''}`);
  return ['OUTCOME KIND       PROVIDER   DETAIL', ...rows, `summary: ok ${report.summary.ok}  warn ${report.summary.warn}  fail ${report.summary.fail}  skipped ${report.summary.skipped}`].join('\n');
}
