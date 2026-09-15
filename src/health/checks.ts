import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROVIDER_REGISTRY, readSecretsEnvValue } from '../adapters/openai-compat.js';
import { CommsLog, DEFAULT_ROOM } from '../comms/log.js';
import { loadLanes, type LanesConfig } from '../lanes.js';
import { loadProjectRegistry } from '../projects.js';
import { isPreferOnlyClass, listTaskClasses, loadRouting, resolveRoute } from '../routing.js';
import { accountResult, catalogModels, loginStatus, targetModels } from './parse.js';
import {
  probe,
  probeFailure,
  errorText,
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
  hooksMs: number;
}

export type LanesLoad = { ok: true; value: LanesConfig } | { ok: false; error: string };

export interface DoctorContext {
  deps: DoctorDeps;
  budgets: DoctorBudgets;
  routingPath: string;
  coreRoot: string;
  heddleDir: string;
  lanes: LanesLoad;
  missing: Set<HarnessProvider>;
}

export const dashboardArtifacts = [
  {
    installed: 'window-keeper.py',
    source: 'scripts/heddle-window-keeper.py',
    installer: 'bash scripts/install-window-keeper-launchd.sh',
  },
  {
    installed: 'heddle-rotation-post.py',
    source: 'scripts/heddle-rotation-post.py',
    installer: 'bash scripts/install-window-keeper-launchd.sh',
  },
  {
    installed: 'usage-tap.mjs',
    source: 'scripts/heddle-usage-tap.mjs',
    installer: 'bash scripts/install-usage-tap.sh',
  },
] as const;

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
          if (isPreferOnlyClass(routing, taskClass)) continue;
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

/**
 * comms readiness (HED-463 / HED-409 acceptance "doctor comms: ok"). READ-ONLY: it must never
 * create ~/.heddle or the db — a health check that provisioned state would defeat its own
 * "not initialized" detection — so it gates on existsSync(commsDbPath) BEFORE opening, and opens in
 * read-only PROBE mode (HED-635): CommsLog { readOnly: true } skips the mkdir, the WAL journal-mode
 * write, and the schema migration, so the diagnostic observes the shared db without mutating it — a
 * newer-schema db is still reported (upgrade heddle), and an older db is read without migration (this
 * check reads only the room, which is schema-independent) and left for the broker to migrate on its
 * next real open. The operator token is checked as a non-empty regular file (statSync metadata only,
 * never its bytes).
 */
export function commsCheck(commsDbPath: string, operatorTokenPath: string): Definition {
  return {
    id: 'comms:ready',
    kind: 'comms',
    run: async () => {
      if (!existsSync(commsDbPath)) {
        return result('warn', 'comms not initialized (no comms.db)', 'run `heddle comms init`');
      }
      // Present = a non-empty regular file (statSync reads metadata only — never the token value);
      // an empty file or a directory is not a usable operator token (codeant security review).
      const tokenStat = existsSync(operatorTokenPath) ? statSync(operatorTokenPath) : null;
      const tokenPresent = tokenStat !== null && tokenStat.isFile() && tokenStat.size > 0;
      let log: CommsLog;
      try {
        log = new CommsLog(commsDbPath, { readOnly: true });
      } catch (err) {
        return result('fail', `comms.db present but cannot be opened: ${errorText(err)}`, 'run `heddle comms init`');
      }
      try {
        // A read-only probe never migrates, so an empty/partial db reaches this read without its
        // tables — surface that as a corrupt-db fail rather than letting the query throw out of run().
        if (log.room(DEFAULT_ROOM) === null) {
          return result('fail', `comms.db present but ${DEFAULT_ROOM} room missing (partial or corrupt db)`, 'run `heddle comms init`');
        }
      } catch (err) {
        return result('fail', `comms.db present but unreadable (${DEFAULT_ROOM} query failed): ${errorText(err)}`, 'run `heddle comms init`');
      } finally {
        log.close();
      }
      return tokenPresent
        ? result('ok', `comms.db, operator token, ${DEFAULT_ROOM} present`)
        : result('warn', `comms.db + ${DEFAULT_ROOM} present, operator token missing`, 'run `heddle comms init` to enable the operator role');
    },
  };
}

export function artifactDriftCheck(ctx: DoctorContext): Definition {
  return {
    id: 'artifacts:drift',
    kind: 'artifact',
    run: async () => {
      // Resolve to absolute ONCE so a relative HEDDLE_DASHBOARD_DIR is not re-applied downstream
      // (git -C + cwd) and so the recovery hints below can reference the checkout unambiguously.
      const dashboardDir = resolve(
        ctx.deps.env.HEDDLE_DASHBOARD_DIR || join(ctx.coreRoot, '..', 'heddle-dashboard'),
      );
      const sourceBytes = await Promise.all(
        dashboardArtifacts.map(({ source }) => ctx.deps.readFileBytes(join(dashboardDir, source))),
      );

      if (sourceBytes.every((bytes) => bytes === undefined)) {
        return result('skipped', 'dashboard source not found — set HEDDLE_DASHBOARD_DIR');
      }

      const drifted: typeof dashboardArtifacts[number][] = [];
      const missing: typeof dashboardArtifacts[number][] = [];
      const sourceMissing: typeof dashboardArtifacts[number][] = [];

      for (const [index, artifact] of dashboardArtifacts.entries()) {
        const source = sourceBytes[index];

        if (source === undefined) {
          sourceMissing.push(artifact);
          continue;
        }

        const installedBytes = await ctx.deps.readFileBytes(join(ctx.heddleDir, artifact.installed));

        if (installedBytes === undefined) {
          missing.push(artifact);
        } else if (ctx.deps.sha256(installedBytes) !== ctx.deps.sha256(source)) {
          drifted.push(artifact);
        }
      }

      const behind = await ctx.deps.gitBehindOriginMain(dashboardDir);
      const details = [
        `${dashboardArtifacts.length - missing.length - sourceMissing.length - drifted.length} artifacts in sync`,
        ...missing.map((artifact) => `~/.heddle/${artifact.installed} not installed`),
        ...sourceMissing.map((artifact) => `${artifact.installed} source missing in dashboard`),
        ...drifted.map((artifact) => `~/.heddle/${artifact.installed} drifted`),
        ...(behind && behind > 0 ? [`${behind} commits behind origin/main`] : []),
      ];
      const hints = [
        // Installer hints run FROM the dashboard checkout (cd), not the caller's cwd; the dir is
        // single-quoted for spaces. The behind note is deliberately non-prescriptive — a checkout on a
        // feature branch or fork cannot blindly `merge --ff-only origin/main`, so we never emit a
        // command that could fail or fast-forward the wrong repository.
        ...drifted.map((artifact) => `~/.heddle/${artifact.installed}: re-run (cd '${dashboardDir}' && ${artifact.installer})`),
        ...(behind && behind > 0
          ? ['dashboard checkout is behind origin/main — update it before relying on the in-sync result']
          : []),
      ];

      // Launchd plists substitute __HOME__, __COMMS_POST__, and __HEDDLE_BIN__ at install time,
      // so they cannot be compared byte-for-byte with their dashboard templates in this v1 check.
      return result(
        drifted.length || (behind !== undefined && behind > 0) ? 'warn' : 'ok',
        details.join('; '),
        hints.length ? hints.join('; ') : undefined,
      );
    },
  };
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
      let present: boolean;
      try {
        present = Boolean(readSecretsEnvValue(config.keyEnv, ctx.deps.paths.secrets));
      } catch (err) {
        const secretsPath = ctx.deps.paths.secrets;
        return result('fail', err instanceof Error ? err.message : String(err),
          `secure ${secretsPath}: a regular file you own, mode 0600, not a symlink (e.g. chmod 600 ${secretsPath})`);
      }
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
