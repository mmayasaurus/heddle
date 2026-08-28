import { PROVIDER_REGISTRY } from './adapters/openai-compat.js';
import { DEFAULT_ACCOUNTS_PATH } from './capaware.js';
import {
  binaryCheck,
  catalogCheck,
  configChecks,
  freshnessCheck,
  harnesses,
  loginCheck,
  type Definition,
  type DoctorContext,
  type HarnessProvider,
  type LanesLoad,
} from './health/checks.js';
import {
  defaultExecFile,
  errorText,
  result,
  type CheckResult,
  type DoctorDeps,
} from './health/probe.js';
import { defaultLanesPath, loadLanes } from './lanes.js';
import { DEFAULT_PROJECTS_PATH } from './projects.js';
import { defaultRoutingPath } from './routing.js';

export type { CheckOutcome, CheckResult, DoctorDeps, ProbeResult } from './health/probe.js';

export interface DoctorReport {
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number; skipped: number };
  exitCode: 0 | 1;
}

export const DOCTOR_PROVIDERS = [
  ...harnesses.map((harness) => harness.provider),
  ...Object.keys(PROVIDER_REGISTRY),
] as const;

function buildContext(
  opts: { provider?: string },
  partial: Partial<DoctorDeps>,
): { deps: DoctorDeps; ctx: DoctorContext; accountsPath: string; projectsPath: string } {
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
  const routingPath =
    deps.paths.routing ?? (deps.env.HEDDLE_ROUTING || undefined) ?? defaultRoutingPath();
  const lanesPath = deps.paths.lanes ?? (deps.env.HEDDLE_LANES || undefined) ?? defaultLanesPath();
  const accountsPath =
    deps.paths.accounts ?? (deps.env.HEDDLE_ACCOUNTS || undefined) ?? DEFAULT_ACCOUNTS_PATH;
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

  return { deps, ctx, accountsPath, projectsPath };
}

function assembleChecks(
  opts: { provider?: string },
  ctx: DoctorContext,
  accountsPath: string,
  projectsPath: string,
): Definition[] {
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

  return definitions;
}

export async function runDoctor(
  opts: { provider?: string },
  partial: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
  const { ctx, accountsPath, projectsPath } = buildContext(opts, partial);
  const definitions = assembleChecks(opts, ctx, accountsPath, projectsPath);
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
