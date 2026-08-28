import { existsSync, readFileSync } from 'node:fs';
import { PROVIDER_REGISTRY, readSecretsEnvValue } from './adapters/openai-compat.js';
import { run } from './adapters/subprocess.js';
import { DEFAULT_ACCOUNTS_PATH, readClaudeAccounts } from './capaware.js';
import { defaultLanesPath, loadLanes, type LanesConfig } from './lanes.js';
import { DEFAULT_PROJECTS_PATH, loadProjectRegistry } from './projects.js';
import {
  defaultRoutingPath,
  listTaskClasses,
  loadRouting,
  resolveRoute,
  type RouteTarget,
} from './routing.js';

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

export interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  execFile: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<ProbeResult>;
  now: () => Date;
  paths: {
    routing?: string;
    lanes?: string;
    projects?: string;
    accounts?: string;
    secrets?: string;
  };
  timeouts?: {
    binaryMs?: number;
    loginMs?: number;
    catalogMs?: number;
    graceMs?: number;
  };
}

type HarnessProvider = 'claude' | 'codex' | 'cursor' | 'gemini';

interface Harness {
  provider: HarnessProvider;
  cli: string;
  installHint: string;
  catalogAuthoritative: boolean;
  loginHint?: string;
  login?: string[];
  catalog?: string[];
}

interface Definition {
  id: string;
  kind: CheckResult['kind'];
  provider?: string;
  run: () => Promise<Omit<CheckResult, 'id' | 'kind' | 'provider'>>;
}

interface DoctorBudgets {
  binaryMs: number;
  loginMs: number;
  catalogMs: number;
  graceMs: number;
}

type LanesLoad = { ok: true; value: LanesConfig } | { ok: false; error: string };

interface DoctorContext {
  deps: DoctorDeps;
  budgets: DoctorBudgets;
  routingPath: string;
  lanes: LanesLoad;
  missing: Set<HarnessProvider>;
}

// This bounds retained output; bounding peak memory while reading belongs in the shared runner (HED-420).
const MAX_STREAM_BYTES = 1_024 * 1_024;

const harnesses: readonly Harness[] = [
  // Verified 2026-08-28: `claude auth status --help` lists `--json` and describes authentication status.
  {
    provider: 'claude',
    cli: 'claude',
    installHint: 'install Claude Code, then run claude /login',
    catalogAuthoritative: false,
    loginHint: 'claude /login',
    login: ['auth', 'status', '--json'],
  },
  // Verified 2026-08-28: `codex login --help` lists `status` as “Show login status”.
  {
    provider: 'codex',
    cli: 'codex',
    installHint: 'install Codex CLI, then run codex login',
    catalogAuthoritative: false,
    loginHint: 'codex login',
    login: ['login', 'status'],
  },
  // Verified 2026-08-28: `cursor-agent status --help` lists `--format json`; `cursor-agent models`
  // --help lists available models.
  {
    provider: 'cursor',
    cli: 'cursor-agent',
    installHint: 'install Cursor Agent, then run cursor-agent login',
    catalogAuthoritative: true,
    loginHint: 'cursor-agent login',
    login: ['status', '--format', 'json'],
    catalog: ['models'],
  },
  // Verified 2026-08-28: `agy --help` has no login-status subcommand; `agy models --help` says
  // “List available models”.
  {
    provider: 'gemini',
    cli: 'agy',
    installHint: 'install Antigravity CLI and authenticate interactively',
    catalogAuthoritative: false,
    catalog: ['models'],
  },
];

export const DOCTOR_PROVIDERS = [
  ...harnesses.map((harness) => harness.provider),
  ...Object.keys(PROVIDER_REGISTRY),
] as const;

function capStream(value: string): string {
  if (Buffer.byteLength(value) <= MAX_STREAM_BYTES) {
    return value;
  }

  let bytes = 0;
  let out = '';

  for (const char of value) {
    const size = Buffer.byteLength(char);

    if (bytes + size > MAX_STREAM_BYTES) {
      break;
    }

    out += char;
    bytes += size;
  }

  return `${out}…[truncated]`;
}

function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<ProbeResult> {
  return run(cmd, args, process.cwd(), opts.timeoutMs).then((probe) => ({
    ...probe,
    stdout: capStream(probe.stdout),
    stderr: capStream(probe.stderr),
  }));
}

function sanitize(detail: string): string {
  return detail
    .trim()
    .replace(/[\r\n]+/g, '; ')
    .replace(/[ \t]+/g, ' ')
    .slice(0, 240);
}

function result(
  outcome: CheckOutcome,
  detail: string,
  hint?: string,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  return hint ? { outcome, detail: sanitize(detail), hint } : { outcome, detail: sanitize(detail) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutResult(
  cli: string,
  timeoutMs: number,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  return result(
    'warn',
    `timed out after ${timeoutMs / 1_000}s — unverified, not proven broken`,
    `re-run; if it persists see docs/LANDMINES.md (${cli})`,
  );
}

async function probe(
  deps: DoctorDeps,
  cmd: string,
  args: string[],
  timeoutMs: number,
  graceMs: number,
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      deps.execFile(cmd, args, { timeoutMs }),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
          timeoutMs + graceMs,
        );
      }),
    ]);
  } catch (error) {
    return { stdout: '', stderr: errorText(error), exitCode: null, timedOut: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function probeFailure(
  probe: ProbeResult,
  cli: string,
  timeoutMs: number,
  installHint: string,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> | undefined {
  if (probe.timedOut) {
    return timeoutResult(cli, timeoutMs);
  }

  if (probe.exitCode !== null) {
    return undefined;
  }

  if (/\bENOENT\b/.test(probe.stderr)) {
    return result('fail', 'missing binary (spawn ENOENT)', installHint);
  }

  const errno = probe.stderr.match(/\bE[A-Z]{2,}\b/)?.[0];

  if (errno) {
    return result('fail', `cannot execute (${errno})`, installHint);
  }

  return result('warn', 'probe could not run — unverified');
}

function loginStatus(stdout: string, stderr: string): boolean | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    for (const key of ['loggedIn', 'isAuthenticated', 'authenticated']) {
      if (typeof parsed[key] === 'boolean') {
        return parsed[key];
      }
    }

    if (parsed.status === 'authenticated') {
      return true;
    }

    if (parsed.status === 'unauthenticated') {
      return false;
    }
  } catch {
    /* Text probes are supported below. */
  }

  const text = `${stdout}\n${stderr}`.trim();

  if (/^logged in/i.test(text)) {
    return true;
  }

  if (/not logged in|logged out|unauthenticated/i.test(text)) {
    return false;
  }

  return undefined;
}

function catalogModels(stdout: string): Set<string> {
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      values.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };

  try {
    walk(JSON.parse(stdout));
  } catch {
    /* Text catalogs parse below. */
  }

  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();

    if (!text) {
      continue;
    }

    for (const candidate of [
      text.split(' - ', 1)[0],
      text.split('\t', 1)[0],
      text.split(/\s+/, 1)[0],
    ]) {
      if (/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(candidate)) {
        values.add(candidate);
      }
    }
  }

  return values;
}

function targetModels(
  provider: HarnessProvider,
  routingPath: string,
): Array<{ taskClass: string; model: string }> {
  const routing = loadRouting(routingPath);
  const targets: Array<{ taskClass: string; model: string }> = [];
  const seen = new Set<string>();
  const addTarget = (taskClass: string, target: RouteTarget): void => {
    const key = `${target.provider}\u0000${target.model}`;

    if (target.provider === provider && !seen.has(key)) {
      seen.add(key);
      targets.push({ taskClass, model: target.model });
    }
  };

  for (const taskClass of listTaskClasses(routing)) {
    const route = resolveRoute(routing, taskClass);

    for (const target of [route, route.fallback].filter(Boolean) as RouteTarget[]) {
      addTarget(taskClass, target);
    }
  }

  for (const [lane, target] of Object.entries(routing.laneDefaults ?? {})) {
    addTarget(`lane-default:${lane}`, target);
  }

  return targets;
}

function accountResult(path: string): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  if (!existsSync(path)) {
    return result(
      'warn',
      'no Claude account registry; headless claude workers use the inherited login',
    );
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { claude?: unknown };

    if (!Array.isArray(raw.claude)) {
      return result('fail', 'accounts.json has no claude[] array', 'fix the file');
    }

    const malformed = raw.claude.filter(
      (row) => !row
        || typeof row !== 'object'
        || Array.isArray(row)
        || typeof (row as Record<string, unknown>).id !== 'string'
        || ('configDir' in row
          && (typeof (row as Record<string, unknown>).configDir !== 'string'
            && (row as Record<string, unknown>).configDir !== null))
        || ('loggedIn' in row && typeof (row as Record<string, unknown>).loggedIn !== 'boolean'),
    ).length;

    if (malformed) {
      return result(
        'fail',
        `accounts.json has ${malformed} malformed claude[] row(s) `
          + '(each needs a string id; configDir string or null; loggedIn boolean)',
        'fix the file',
      );
    }
  } catch {
    return result('fail', 'accounts.json is not valid JSON', 'fix the file');
  }

  const accounts = readClaudeAccounts(path);
  const loggedIn = accounts.filter((account) => account.loggedIn !== false).length;

  return result(
    'ok',
    `${accounts.length} Claude account${accounts.length === 1 ? '' : 's'}; ${loggedIn} logged in`,
  );
}

function binaryCheck(harness: Harness, ctx: DoctorContext): Definition {
  return {
    id: `binary:${harness.provider}`,
    kind: 'binary',
    provider: harness.provider,
    run: async () => {
      const probeResult = await probe(
        ctx.deps,
        harness.cli,
        ['--version'],
        ctx.budgets.binaryMs,
        ctx.budgets.graceMs,
      );
      const failure = probeFailure(
        probeResult,
        harness.cli,
        ctx.budgets.binaryMs,
        harness.installHint,
      );

      if (failure) {
        if (failure.detail === 'missing binary (spawn ENOENT)') {
          ctx.missing.add(harness.provider);
        }

        return failure;
      }

      if (probeResult.exitCode !== 0) {
        return result(
          'fail',
          `${harness.cli} --version exited ${probeResult.exitCode}`,
          harness.installHint,
        );
      }

      return result(
        'ok',
        probeResult.stdout.trim().slice(0, 80) || `${harness.cli} installed`,
      );
    },
  };
}

function loginCheck(harness: Harness, ctx: DoctorContext): Definition {
  return {
    id: `login:${harness.provider}`,
    kind: 'login',
    provider: harness.provider,
    run: async () => {
      if (ctx.missing.has(harness.provider)) {
        return result('skipped', 'binary missing');
      }

      if (!harness.login) {
        return result('skipped', `no login probe verified for ${harness.cli}`);
      }

      const probeResult = await probe(
        ctx.deps,
        harness.cli,
        harness.login,
        ctx.budgets.loginMs,
        ctx.budgets.graceMs,
      );
      const failure = probeFailure(
        probeResult,
        harness.cli,
        ctx.budgets.loginMs,
        harness.installHint,
      );

      if (failure) {
        return failure;
      }

      const state = loginStatus(probeResult.stdout, probeResult.stderr);

      if (state === undefined) {
        return result(
          'warn',
          `unrecognized status output${
            probeResult.exitCode === 0 ? '' : ` (exit ${probeResult.exitCode})`
          }`,
        );
      }

      const inherited = harness.provider === 'cursor'
        ? 'CURSOR_API_KEY'
        : harness.provider === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN' : undefined;
      const inheritedNote = inherited && ctx.deps.env[inherited]
        ? ` (inherited ${inherited} ignored — heddle workers do not receive it; register the account instead)`
        : '';

      return state
        ? result('ok', `logged in${inheritedNote}`)
        : result('fail', `logged out${inheritedNote}`, harness.loginHint);
    },
  };
}

function catalogCheck(harness: Harness, ctx: DoctorContext): Definition {
  return {
    id: `catalog:${harness.provider}`,
    kind: 'catalog',
    provider: harness.provider,
    run: async () => {
      if (ctx.missing.has(harness.provider)) {
        return result('skipped', 'binary missing');
      }

      if (!harness.catalog) {
        return result('skipped', `no catalog command verified for ${harness.cli}`);
      }

      const targets = targetModels(harness.provider, ctx.routingPath);

      if (!targets.length) {
        return result('skipped', `no routed models for ${harness.provider}`);
      }

      const probeResult = await probe(
        ctx.deps,
        harness.cli,
        harness.catalog,
        ctx.budgets.catalogMs,
        ctx.budgets.graceMs,
      );
      const failure = probeFailure(
        probeResult,
        harness.cli,
        ctx.budgets.catalogMs,
        harness.installHint,
      );

      if (failure) {
        return failure;
      }

      if (probeResult.exitCode !== 0) {
        return result(
          'fail',
          `${harness.cli} ${harness.catalog.join(' ')} exited ${probeResult.exitCode}`,
        );
      }

      const available = catalogModels(probeResult.stdout);
      const absent = targets.filter((target) => !available.has(target.model));

      return absent.length
        ? harness.catalogAuthoritative
          ? result(
              'fail',
              absent.map((target) => `${target.taskClass}: ${target.model}`).join('; '),
              'update the routing model or choose an available catalog model',
            )
          : result(
              'warn',
              absent
                .map(
                  (target) => `${target.taskClass}: ${target.model} not listed — agy catalog can lag `
                    + 'a new model (docs/MODELS.md); unverified',
                )
                .join('; '),
            )
        : result(
            'ok',
            `${targets.length} routed model${targets.length === 1 ? '' : 's'} present`,
          );
    },
  };
}

function configChecks(
  ctx: DoctorContext,
  accountsPath: string,
  projectsPath: string,
): Definition[] {
  return [
    {
      id: 'config:routing',
      kind: 'config',
      run: async () => {
        const routing = loadRouting(ctx.routingPath);

        for (const taskClass of listTaskClasses(routing)) {
          resolveRoute(routing, taskClass);
        }

        return result('ok', `${listTaskClasses(routing).length} task classes resolve`);
      },
    },
    {
      id: 'config:lanes',
      kind: 'config',
      run: async () =>
        ctx.lanes.ok ? result('ok', 'lanes.yaml parses') : result('fail', ctx.lanes.error),
    },
    {
      id: 'config:projects',
      kind: 'config',
      run: async () => {
        const registry = loadProjectRegistry(projectsPath);

        return !existsSync(projectsPath)
          ? result('ok', 'absent; consumers fall back to cwd inference')
          : result(
              'ok',
              `${registry.projects.length} project${registry.projects.length === 1 ? '' : 's'} registered`,
            );
      },
    },
    {
      id: 'config:claude-accounts',
      kind: 'config',
      run: async () => accountResult(accountsPath),
    },
  ];
}

function freshnessCheck(
  provider: keyof typeof PROVIDER_REGISTRY,
  config: (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY],
  ctx: DoctorContext,
): Definition {
  return {
    id: `freshness:${provider}`,
    kind: 'freshness',
    provider,
    run: async () => {
      if (!ctx.lanes.ok) {
        return result('skipped', 'lanes.yaml unavailable — see config:lanes');
      }

      const days = Math.floor(
        (ctx.deps.now().getTime() - new Date(config.lastVerified).getTime()) / 86_400_000,
      );
      const present = Boolean(readSecretsEnvValue(config.keyEnv, ctx.deps.paths.secrets));
      const verification =
        days > ctx.lanes.value.floors.menial_verify_days
          ? `last verified ${days} days ago (> ${ctx.lanes.value.floors.menial_verify_days})`
          : `last verified ${days} days ago`;

      return result(
        days > ctx.lanes.value.floors.menial_verify_days || !present ? 'warn' : 'ok',
        `${verification}; ${config.keyEnv}: ${
          present ? 'present in secrets.env' : 'absent from secrets.env'
        }`,
      );
    },
  };
}

export async function runDoctor(
  opts: { provider?: string },
  partial: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
  if (
    opts.provider
    && !DOCTOR_PROVIDERS.includes(opts.provider as (typeof DOCTOR_PROVIDERS)[number])
  ) {
    throw new Error(
      `unknown provider "${opts.provider}" — known: ${DOCTOR_PROVIDERS.join(', ')}`,
    );
  }
  const deps: DoctorDeps = {
    env: partial.env ?? process.env,
    execFile: partial.execFile ?? defaultExecFile,
    now: partial.now ?? (() => new Date()),
    paths: partial.paths ?? {},
  };
  const routingPath = deps.paths.routing ?? (deps.env.HEDDLE_ROUTING || undefined) ?? defaultRoutingPath();
  const lanesPath = deps.paths.lanes ?? (deps.env.HEDDLE_LANES || undefined) ?? defaultLanesPath();
  const accountsPath = deps.paths.accounts ?? (deps.env.HEDDLE_ACCOUNTS || undefined) ?? DEFAULT_ACCOUNTS_PATH;
  const projectsPath = deps.paths.projects ?? DEFAULT_PROJECTS_PATH;
  const lanes: LanesLoad = (() => {
    try {
      return { ok: true, value: loadLanes(lanesPath) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  })();
  const ctx: DoctorContext = {
    deps,
    budgets: {
      binaryMs: partial.timeouts?.binaryMs ?? 5_000,
      loginMs: partial.timeouts?.loginMs ?? 15_000,
      catalogMs: partial.timeouts?.catalogMs ?? 20_000,
      graceMs: partial.timeouts?.graceMs ?? 2_000,
    },
    routingPath,
    lanes,
    missing: new Set<HarnessProvider>(),
  };
  const selected = new Set(
    harnesses
      .filter((harness) => !opts.provider || harness.provider === opts.provider)
      .map((harness) => harness.provider),
  );
  const definitions: Definition[] = harnesses
    .filter((harness) => selected.has(harness.provider))
    .flatMap((harness) => [
      binaryCheck(harness, ctx),
      loginCheck(harness, ctx),
      catalogCheck(harness, ctx),
    ]);
  definitions.push(...configChecks(ctx, accountsPath, projectsPath));
  for (const [provider, config] of Object.entries(PROVIDER_REGISTRY) as Array<
    [keyof typeof PROVIDER_REGISTRY, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]]
  >) {
    if (opts.provider && opts.provider !== provider) {
      continue;
    }

    definitions.push(freshnessCheck(provider, config, ctx));
  }
  const checks: CheckResult[] = [];

  for (const definition of definitions) {
    try {
      checks.push({
        id: definition.id,
        kind: definition.kind,
        ...(definition.provider ? { provider: definition.provider } : {}),
        ...(await definition.run()),
      });
    } catch (error) {
      checks.push({
        id: definition.id,
        kind: definition.kind,
        ...(definition.provider ? { provider: definition.provider } : {}),
        ...result('fail', errorText(error)),
      });
    }
  }

  const summary = checks.reduce(
    (counts, entry) => ({ ...counts, [entry.outcome]: counts[entry.outcome] + 1 }),
    { ok: 0, warn: 0, fail: 0, skipped: 0 },
  );

  return { checks, summary, exitCode: summary.fail ? 1 : 0 };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map(
    (check) =>
      `${check.outcome.padEnd(7)} ${check.kind.padEnd(10)} ${
        (check.provider ?? 'global').padEnd(10)
      } ${check.detail}${check.hint ? ` — ${check.hint}` : ''}`,
  );

  return [
    'OUTCOME KIND       PROVIDER   DETAIL',
    ...rows,
    `summary: ok ${report.summary.ok}  warn ${report.summary.warn}  `
      + `fail ${report.summary.fail}  skipped ${report.summary.skipped}`,
  ].join('\n');
}
