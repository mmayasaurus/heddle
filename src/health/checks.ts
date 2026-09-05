import { existsSync } from 'node:fs';
import { PROVIDER_REGISTRY, readSecretsEnvValue } from '../adapters/openai-compat.js';
import { loadLanes, type LanesConfig } from '../lanes.js';
import { loadProjectRegistry } from '../projects.js';
import { listTaskClasses, loadRouting, resolveRoute } from '../routing.js';
import { accountResult, catalogModels, loginStatus, targetModels } from './parse.js';
import {
  probe,
  probeFailure,
  result,
  type CheckResult,
  type DoctorDeps,
} from './probe.js';

export type HarnessProvider = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface Harness {
  provider: HarnessProvider;
  cli: string;
  installHint: string;
  catalogAuthoritative: boolean;
  loginHint?: string;
  login?: string[];
  catalog?: string[];
}

export interface Definition {
  id: string;
  kind: CheckResult['kind'];
  provider?: string;
  run: () => Promise<Omit<CheckResult, 'id' | 'kind' | 'provider'>>;
}

export interface DoctorBudgets {
  binaryMs: number;
  loginMs: number;
  catalogMs: number;
  graceMs: number;
}

export type LanesLoad = { ok: true; value: LanesConfig } | { ok: false; error: string };

export interface DoctorContext {
  deps: DoctorDeps;
  budgets: DoctorBudgets;
  routingPath: string;
  lanes: LanesLoad;
  missing: Set<HarnessProvider>;
}

export const harnesses: readonly Harness[] = [
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

export function binaryCheck(harness: Harness, ctx: DoctorContext): Definition {
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

export function loginCheck(harness: Harness, ctx: DoctorContext): Definition {
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

export function catalogCheck(harness: Harness, ctx: DoctorContext): Definition {
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

export function configChecks(
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

export function freshnessCheck(
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
