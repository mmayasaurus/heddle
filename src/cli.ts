#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// node:sqlite is stable enough for our use but still flagged experimental; the warning would
// pollute stdout parsing for agents, so it is suppressed at the entry point only —
// `--disable-warning=<type>` silences just that category (`--no-warnings` would hide every
// process warning; its `=…` suffix is ignored — verified Node 22.23, 2026-08-15).
import { existsSync } from 'node:fs';
import { dispatch, planDispatch, summarizePlan } from './dispatch.js';
import { Ledger } from './ledger.js';
import { loadRouting, describeTaskClasses } from './routing.js';
import { listPacks, withMandatoryPacks } from './skillpacks.js';
import { classifyEffort, assessResult } from './classify.js';
import { resolveIdentity } from './identity.js';
import { loadProjectRegistry, DEFAULT_PROJECTS_PATH } from './projects.js';
import { isDispatchExcluded, pickClaudeAccount, readClaudeAccounts } from './capaware.js';
import { bindingMeter, claudeFloorsFrom, headroomPct, isFloored } from './floors.js';
import { loadLanes } from './lanes.js';
import { LIMITS_JSON_MAX_AGE_S, readProviderCaps } from './usage.js';

/**
 * heddle CLI — the surface orchestrators (and later the dashboard) drive.
 * Every command supports --json so both agents and the GUI parse the same output.
 */

const USAGE = `heddle — cross-provider orchestration for subscription coding CLIs

  heddle dispatch (--class <c> | --provider <p> --model <m>) --task "<prompt>" [options]
      --class <c>          task class from the routing table (see: heddle classes) — policy path
      --provider <p>       name a provider directly (codex|cursor|gemini) — dynamic override
      --model <m>          the model id for --provider (e.g. cursor-grok-4.5-high)
      --task <text>        the sub-task prompt (or pipe via stdin)
      --cwd <path>         working directory for the worker (default: cwd)
      --issue <SPI-n>      Linear issue this sub-task serves
      --agent <X>          dispatching orchestrator's fleet identity
      --skills a,b         replace the task class's default skill packs (worker-role stays)
      --mcp a,b            attach code-discovery MCP servers (e.g. memtrace)
      --effort <level>     reasoning effort: codex minimal|low|medium|high|xhigh; agy low|medium|high
      --auto-effort        classify the task's difficulty (cheap model) and pin effort automatically
      --resume <id>        continue a prior worker session
      --timeout <ms>       wall-clock budget (default 600000)
      --codex-home <path>  account selection for codex workers
      --opt-in             required for task classes that gate on it (and for exec-privileged)
      --override-reason <r> REQUIRED with --provider/--model when no --class: why this bypasses the
                           routing table (recorded on the ledger row; HED-95)
      --no-fallback        do not try the table's fallback on failure
      --capabilities a,b   GRANT worker capabilities: net | browse | exec-privileged (default: none)
      --in-session         claude classes: return the in-session (Agent tool) instruction instead of a headless worker
      --account <id>       claude classes: pin the registry account (default: most 5h headroom)
      --author-provider <p>  adversarial-review: who authored the change — the reviewer will be a different provider
      --author-dispatch <id> adversarial-review: ledger id of the authoring dispatch (lineage)
      --diff-base <ref>    adversarial-review: heddle prepends "review git diff <ref>...HEAD" to the task
      --json               machine-readable result

  heddle classify-effort --class <c> --task "<prompt>" [--json]   difficulty → effort (cheap model)
  heddle assess --task "<prompt>" --output "<worker output>" [--ok] [--json]
                                 judge a worker result: done | needs-rework | needs-human
  heddle route (--class <c> | --provider <p> --model <m>) [--class <c> --provider <p> --model <m>] [--opt-in] [--json]
                                 DRY RUN: where a dispatch would go right now and why (live caps, cap-aware
                                 routing, account advice) — no ledger row, no worker
  heddle classes [--json]        task classes: route, why, default skill packs, edits-code
  heddle packs                   list available skill packs
  heddle projects [--json]       registered projects and their fleets (~/.heddle/projects.json; HED-160)
  heddle whoami [--json]         this process's bound identity (HEDDLE_AGENT / FLEET_AGENT / .fleet-agent) + worker context
  heddle workers [--stale <hours>] [--json]   dispatches still in flight (--stale: only orphans older than N hours)
  heddle ledger [--issue SPI-n] [--limit N] [--json]
  heddle ledger finish <id> --error "<why>"   close an orphaned in-flight row (ok=0)
  heddle ledger show <id> [--json]             show one dispatch and its recorded worker output
  heddle ledger sweep [--dry-run] [--max-age-h N] [--json]   close orphans: age > N hours (default 24)
                                 or owner process provably gone (outcome='orphaned'); dry-run lists only
  heddle ledger report-in-session <id> (--ok | --failed) [--error "<why>"] [--input-tokens N] [--cached-input-tokens N] [--output-tokens N] [--reasoning-tokens N] [--duration-ms N] [--json]  administrative path: may report any orchestrator's handoff
  heddle usage [--since <iso>] [--json]    per-provider totals
  heddle account pick [--for <letter>] [--json] [--explain]   healthiest addressable Claude account for a fleet relaunch
  heddle reviews [--limit N] [--json]      adversarial-review scoreboard (author→reviewer pairs) + recent reviews
  heddle review-outcome <dispatch-id> --total N --accepted M [--notes "…"]   record how many findings you accepted
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function out(json: boolean, obj: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(obj, null, 2) : text());
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const cmd = process.argv[2];
const json = has('--json');

/**
 * Orphan hygiene at CLI start (HED-90): close provably-dead in-flight rows so every read below sees
 * an honest ledger. Skipped for `ledger sweep` (its --dry-run must observe, not mutate) AND for
 * `ledger finish` (the operator's manual close of a real orphan must win, with THEIR reason — the
 * auto-sweep pre-empting it would discard the diagnostic and fail the command). Best-effort — a
 * hygiene failure must never break the command the operator actually ran.
 */
if (!(cmd === 'ledger' && (process.argv[3] === 'sweep' || process.argv[3] === 'finish'))) {
  try {
    const { closed } = new Ledger().sweepOrphans();
    if (closed > 0) console.error(`heddle: closed ${closed} orphaned in-flight dispatch row${closed === 1 ? '' : 's'} (heddle ledger --json shows outcome='orphaned')`);
  } catch { /* hygiene is best-effort */ }
}

try {
  switch (cmd) {
    case 'dispatch': {
      const taskClass = arg('--class');
      const provider = arg('--provider');
      const model = arg('--model');
      const prompt = arg('--task') ?? (await readStdin());
      const hasDirect = Boolean(provider && model);
      if ((!taskClass && !hasDirect) || !prompt) {
        console.error('dispatch requires --task plus either --class or (--provider AND --model)\n');
        console.error(USAGE);
        process.exit(2);
      }
      const env: Record<string, string> = {};
      const codexHome = arg('--codex-home');
      if (codexHome) env.CODEX_HOME = codexHome;

      const res = await dispatch({
        taskClass,
        provider,
        model,
        prompt,
        cwd: arg('--cwd') ?? process.cwd(),
        issue: arg('--issue'),
        orchestrator: arg('--agent'),
        skills: arg('--skills')?.split(',').map((s) => s.trim()).filter(Boolean),
        mcp: arg('--mcp')?.split(',').map((s) => s.trim()).filter(Boolean),
        effort: arg('--effort'),
        autoEffort: has('--auto-effort'),
        resume: arg('--resume'),
        timeoutMs: arg('--timeout') ? Number(arg('--timeout')) : undefined,
        env: Object.keys(env).length ? env : undefined,
        optIn: has('--opt-in'),
        overrideReason: arg('--override-reason'),
        noFallback: has('--no-fallback'),
        capabilities: arg('--capabilities')?.split(',').map((s) => s.trim()).filter(Boolean),
        inSession: has('--in-session'),
        accountPin: arg('--account'),
        authorProvider: arg('--author-provider'),
        authorDispatchId: arg('--author-dispatch') ? Number(arg('--author-dispatch')) : undefined,
        diffBase: arg('--diff-base'),
      });

      const { raw, ...summary } = res;
      out(json, summary, () => {
        const head = `${res.ok ? '✓' : '✗'} ${res.taskClass} → ${res.provider}/${res.model}` +
          (res.usedFallback ? ' (fallback)' : '') +
          (res.refusal ? ` [refused: ${res.refusal.code}]` : '') +
          (res.durationMs ? ` · ${(res.durationMs / 1000).toFixed(1)}s` : '') +
          (res.sessionId ? `\n  resume: ${res.sessionId}` : '');
        // An escape warning must reach a HUMAN on the success path too — the whole point is that
        // ok:true and "your shared checkout was modified" are both true at once (PR #28).
        const esc = (res.escape ? `\n  ⚠ ${res.escape.note}` : '') + (res.destroyed ? `\n  ⚠ ${res.destroyed.note}` : '');
        return res.ok ? `${head}${esc}\n\n${res.output}` : `${head}\n  error: ${res.error}${esc}` + (res.output ? `\n\n${res.output}` : '');
      });
      process.exit(res.ok ? 0 : 1);
      break;
    }

    case 'route': {
      const taskClass = arg('--class');
      const provider = arg('--provider');
      const model = arg('--model');
      if (!taskClass && !(provider && model)) {
        console.error('route requires --class <c> and/or --provider <p> --model <m>');
        process.exit(2);
      }
      const env: Record<string, string> = {};
      const codexHome = arg('--codex-home');
      if (codexHome) env.CODEX_HOME = codexHome;
      const plan = planDispatch({
        taskClass, provider, model, prompt: '(dry run)', cwd: arg('--cwd') ?? process.cwd(),
        optIn: has('--opt-in'), env: Object.keys(env).length ? env : undefined,
        inSession: has('--in-session'), accountPin: arg('--account'),
        authorProvider: arg('--author-provider'), overrideReason: arg('--override-reason'),
      });
      const summary = summarizePlan(plan) as any;
      out(json, summary, () =>
        `${plan.route.taskClass}` +
        (summary.reviewer_pick ? `\n  reviewer: ${summary.reviewer_pick}` : '') +
        (summary.refusal ? `\n  ✗ WOULD REFUSE (${summary.refusal.code}): ${summary.refusal.reason}`
          : `\n  → ${summary.would_run}${summary.in_session ? '  [in-session: use your Agent tool]' : ''}` +
            (summary.routed_away_for_cap ? '  (routed away for cap)' : '')) +
        `\n  reason: ${summary.route_reason}` +
        (summary.remaining_fallback ? `\n  fallback if it fails: ${summary.remaining_fallback}` : '') +
        (summary.account_pick ? `\n  ${summary.account_pick.reason}` : '') +
        (summary.account_advice ? `\n  ${summary.account_advice}` : '') +
        `\n  checks:\n    - ${summary.checks.join('\n    - ')}`);
      break;
    }

    case 'account': {
      if (process.argv[3] !== 'pick') {
        console.error('usage: heddle account pick [--for <letter>] [--json] [--explain]');
        process.exit(2);
      }
      const accounts = readClaudeAccounts();
      const caps = readProviderCaps();
      const floors = claudeFloorsFrom(loadLanes());
      // Residency-balancing by --for is a later increment; this identifies the agent being launched only.
      const forAgent = arg('--for');
      if (has('--for') && (!forAgent || forAgent.startsWith('--'))) {
        console.error('usage: heddle account pick [--for <letter>] [--json] [--explain]');
        process.exit(2);
      }
      const claudeCaps = caps.claude;
      // Exit 2 = cannot decide (missing/stale meters); distinct from exit 1 = decided, none healthy.
      // Age-key on capturedAt, NOT the `stale` flag alone: the flag can read fresh while the data is
      // hours old (HED-348 keeper bug — limits.json rewritten ~every 5 min bumps the file's writtenAt
      // while a provider entry's capturedAt lags), and picking on 45–50%-wrong caps is the exact
      // rollover risk this guard exists to stop. A surfaced capture older than the mirror freshness
      // window (or an absent capturedAt) is UNKNOWN → refuse, never pick (R nod 2026-08-22). Safe now;
      // useful once HED-348/HED-337 land and fresh caps surface. Keep the flag too (belt + suspenders).
      const capturedAt = claudeCaps?.capturedAt ?? null;
      const ageS = capturedAt === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - capturedAt);
      if (!claudeCaps || claudeCaps.source === 'none' || claudeCaps.stale || ageS === null || ageS > LIMITS_JSON_MAX_AGE_S) {
        const age = ageS === null
          ? 'unknown (capturedAt unavailable)'
          : `${ageS}s (capturedAt ${capturedAt}, budget ${LIMITS_JSON_MAX_AGE_S}s)`;
        console.error(`heddle: cannot decide Claude account pick: caps are missing or stale (data age ${age}); use an explicit account prompt`);
        process.exit(2);
      }
      const pick = pickClaudeAccount(claudeCaps, accounts, { floors });
      const usedOf = (id: string): number | null => {
        const row = claudeCaps.accounts.find((account) => account.id === id);
        return row && !row.stale ? row.fiveHour.usedPercentage : null;
      };
      const used7dOf = (id: string): number | null => {
        const row = claudeCaps.accounts.find((account) => account.id === id);
        return row && !row.stale ? row.sevenDay.usedPercentage : null;
      };
      const accountRows = accounts.map((account) => {
        const usedPct = usedOf(account.id);
        const usedPct7d = used7dOf(account.id);
        const meter = bindingMeter(usedPct, usedPct7d);
        const floored = isFloored(usedPct, usedPct7d, floors);
        const loggedOut = account.loggedIn === false;
        const dispatchExcluded = isDispatchExcluded(caps.claude, account.id);
        return {
          account: account.id,
          usedPct5h: usedPct,
          usedPct7d,
          headroomPct: meter === '5h' ? headroomPct(usedPct) : meter === '7d' ? headroomPct(usedPct7d) : null,
          bindingMeter: meter,
          floored,
          loggedOut,
          dispatchExcluded,
          excluded: floored || loggedOut || dispatchExcluded,
        };
      });
      if (!pick) {
        if (accounts.length === 0) {
          console.error('heddle: refusing Claude account pick: no accounts registered in ~/.heddle/accounts.json');
          process.exit(1);
        }
        // Classify each unavailable account by ONE reason (priority logged-out → dispatch-excluded →
        // floored) so the counts sum to the registry size rather than double-count an account that is
        // several at once (e.g. a logged-out account also over the floor).
        let loggedOut = 0, dispatchExcluded = 0, floored = 0;
        for (const account of accountRows) {
          if (account.loggedOut) loggedOut++;
          else if (account.dispatchExcluded) dispatchExcluded++;
          else if (account.floored) floored++;
        }
        console.error(`heddle: refusing Claude account pick: none of ${accounts.length} registered account(s) is healthy — ` +
          `${floored} floored (5h or 7d headroom ≤ ${floors.neverBelowPct}%), ${loggedOut} logged-out, ${dispatchExcluded} dispatch-excluded`);
        process.exit(1);
      }
      const selectedRow = claudeCaps.accounts.find((account) => account.id === pick.account.id);
      const meter = bindingMeter(pick.usedPct, pick.usedPct7d);
      const resetsAt = meter === '5h' ? selectedRow?.fiveHour.resetsAt ?? null
        : meter === '7d' ? selectedRow?.sevenDay.resetsAt ?? null : null;
      const data = {
        account: pick.account.id,
        configDir: pick.account.configDir,
        unsetConfigDir: pick.envUnset.includes('CLAUDE_CONFIG_DIR'),
        usedPct5h: pick.usedPct,
        usedPct7d: pick.usedPct7d,
        bindingMeter: meter,
        resetsAt,
        reason: pick.reason,
        ...(forAgent ? { for: forAgent } : {}),
        ...(has('--explain') ? { accounts: accountRows } : {}),
      };
      out(json, data, () => {
        const config = pick.account.configDir
          ? `CLAUDE_CONFIG_DIR=${pick.account.configDir}`
          : 'default login — leave CLAUDE_CONFIG_DIR unset';
        const selected = `${pick.account.id}  ${config}  ${pick.reason}` + (forAgent ? `  for: ${forAgent}` : '');
        if (!has('--explain')) return selected;
        const details = accountRows.map((account) => {
          const state = [
            account.floored ? 'floored' : null,
            account.loggedOut ? 'logged-out' : null,
            account.dispatchExcluded ? 'dispatch-excluded' : null,
          ].filter(Boolean).join(', ') || 'eligible';
          const meter = account.bindingMeter === null ? 'no known meter' : `${account.bindingMeter} binds`;
          return `${account.account}: 5h ${account.usedPct5h === null ? 'unknown' : `${account.usedPct5h.toFixed(0)}%`}, ` +
            `7d ${account.usedPct7d === null ? 'unknown' : `${account.usedPct7d.toFixed(0)}%`}, ` +
            `headroom ${account.headroomPct === null ? 'unknown' : `${account.headroomPct.toFixed(0)}%`} (${meter}), ${state}`;
        }).join('\n');
        return `${selected}\n${details}`;
      });
      break;
    }

    case 'classify-effort': {
      const taskClass = arg('--class') ?? 'general';
      const task = arg('--task') ?? (await readStdin());
      if (!task) { console.error('classify-effort requires --task (or piped stdin)'); process.exit(2); }
      const effort = await classifyEffort(taskClass, task, arg('--cwd') ?? process.cwd());
      out(json, { taskClass, effort: effort ?? null, matched: effort !== undefined },
        () => effort ?? '(unclassified — route/default effort applies)');
      break;
    }

    case 'assess': {
      const task = arg('--task') ?? '';
      const output = arg('--output') ?? (await readStdin());
      if (!task || !output) { console.error('assess requires --task and --output (or piped stdin)'); process.exit(2); }
      const a = await assessResult(task, output, has('--ok'), arg('--cwd') ?? process.cwd());
      out(json, a, () => `${a.label}${a.matched ? '' : ' (unmatched — model reply was ambiguous)'}`);
      break;
    }

    case 'classes': {
      const rows = describeTaskClasses(loadRouting(), withMandatoryPacks);
      out(json, rows, () => rows.map((r) =>
        `${r.task_class.padEnd(22)} ${r.provider}/${r.model}` +
        (r.effort ? ` (${r.effort})` : '') +
        (r.fallback ? `  ↳ ${r.fallback}` : '') +
        (r.opt_in_required ? '  [opt-in required]' : '') +
        (r.execution === 'in-session-subagent' ? '  [in-session: use your Agent tool — heddle dispatch refuses it]' : '') +
        (r.provider === 'claude' ? '  [claude: headless on the account with most headroom; --in-session keeps the subagent protocol]' : '') +
        (r.edits_code ? '  [edits code]' : '') +
        (r.read_only ? '  [read-only]' : '') +
        (r.reviewer_pool.length ? `  pool: ${r.reviewer_pool.join(' → ')}` : '') +
        `\n${''.padEnd(23)}skills: ${r.skills.join(', ') || '(none)'}` +
        (r.mcp.length ? `  mcp: ${r.mcp.join(', ')}` : '') +
        (r.why ? `\n${''.padEnd(23)}why: ${r.why}` : '')).join('\n'));
      break;
    }

    case 'packs': {
      const packs = listPacks();
      out(json, packs, () => packs.length ? packs.join('\n') : '(no skill packs yet)');
      break;
    }

    case 'whoami': {
      const id = resolveIdentity(process.cwd());
      out(json, id, () => `agent: ${id.agent ?? '(unbound)'}  source: ${id.source}` +
        (id.worker ? `\nWORKER context: dispatch #${id.worker.dispatchId ?? '?'} parent ${id.worker.parent ?? '?'} — this process may not dispatch (depth-1)` : ''));
      break;
    }

    case 'workers': {
      const staleHours = arg('--stale');
      if (staleHours !== undefined && !(Number.isFinite(Number(staleHours)) && Number(staleHours) > 0)) {
        console.error('usage: heddle workers [--stale <hours>] — <hours> must be a positive number');
        process.exit(2);
      }
      const ledger = new Ledger();
      const rows = staleHours ? ledger.staleInFlight(Number(staleHours) * 3_600_000) : ledger.inFlight();
      out(json, rows, () => rows.length
        ? rows.map((r) => `#${r.id} ${r.provider}/${r.model} ${r.task_class}` +
            (r.orchestrator ? ` [${r.orchestrator}]` : '') +
            (r.issue ? ` ${r.issue}` : '') + ` since ${r.started_at}`).join('\n') +
          (staleHours ? `\n(close an orphan: heddle ledger finish <id> --error "…")` : '')
        : (staleHours ? `(no in-flight rows older than ${staleHours}h)` : '(nothing in flight)'));
      break;
    }

    case 'ledger': {
      if (process.argv[3] === 'show') {
        const id = Number(process.argv[4]);
        if (!Number.isInteger(id)) {
          console.error('usage: heddle ledger show <id> [--json]');
          process.exit(2);
        }
        const row = new Ledger().getWithOutput(id);
        if (!row) {
          console.error(`heddle: no dispatch #${id}`);
          process.exit(1);
        }
        const { output, ...summary } = row;
        out(json, row, () => `${JSON.stringify(summary, null, 2)}\n\n${output ?? '(no output recorded)'}`);
        break;
      }
      if (process.argv[3] === 'sweep') {
        const maxAgeH = arg('--max-age-h');
        // `has()` distinguishes "--max-age-h given without a value" (an error a hurried operator
        // must see — silently sweeping at the 24h default would look like the custom sweep ran)
        // from "flag absent" (the default is intended).
        if (has('--max-age-h') && !(Number.isFinite(Number(maxAgeH)) && Number(maxAgeH) > 0)) {
          console.error('usage: heddle ledger sweep [--dry-run] [--max-age-h N] — N must be a positive number');
          process.exit(2);
        }
        const dryRun = has('--dry-run');
        const { candidates, closed } = new Ledger().sweepOrphans({
          dryRun,
          maxAgeMs: maxAgeH ? Number(maxAgeH) * 3_600_000 : undefined,
        });
        out(json, { dryRun, closed, candidates }, () => candidates.length
          ? candidates.map((c) => `${dryRun ? 'would close' : 'closed'} #${c.id} (started ${c.startedAt}): ${c.reason}`).join('\n') +
            (dryRun ? `\n(${candidates.length} candidate${candidates.length === 1 ? '' : 's'} — run without --dry-run to close)` : `\n(${closed} closed)`)
          : '(no orphaned in-flight rows)');
        break;
      }
      if (process.argv[3] === 'finish') {
        const id = Number(process.argv[4]);
        const error = arg('--error');
        if (!Number.isInteger(id) || !error) {
          console.error('usage: heddle ledger finish <id> --error "<why>"');
          process.exit(2);
        }
        const ledger = new Ledger();
        // Atomic: only an in-flight row can be closed; a row the worker already finished stays as is.
        if (!ledger.closeIfInFlight(id, `closed manually: ${error}`)) {
          console.error(`heddle: row #${id} is not in flight (no such row, or already finished) — nothing to close`);
          process.exit(1);
        }
        out(json, { id, closed: true }, () => `closed #${id} (ok=0): ${error}`);
        break;
      }
      if (process.argv[3] === 'report-in-session') {
        const usage = 'usage: heddle ledger report-in-session <id> (--ok | --failed) [--error "<why>"] [--input-tokens N] [--cached-input-tokens N] [--output-tokens N] [--reasoning-tokens N] [--duration-ms N] [--json]';
        const numericFlag = (flag: string): number | undefined => {
          const index = process.argv.indexOf(flag);
          if (index === -1) return undefined;
          const raw = process.argv[index + 1];
          const value = raw === undefined || raw.startsWith('-') ? NaN : Number(raw);
          if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
            console.error(usage);
            process.exit(2);
          }
          return value;
        };
        const id = Number(process.argv[4]);
        const ok = has('--ok');
        const failed = has('--failed');
        // `id <= 0` belongs here, not only in the ledger: reportInSession THROWS on a bad id (a
        // caller bug, deliberately not a `false` return), and an operator who typed `0` should get
        // the usage line and exit 2 like every other bad argument — not a stack trace.
        if (!Number.isInteger(id) || id <= 0 || ok === failed) {
          console.error(usage);
          process.exit(2);
        }
        const ledger = new Ledger();
        const matched = ledger.reportInSession(id, {
          ok,
          error: arg('--error'),
          inputTokens: numericFlag('--input-tokens'),
          cachedInputTokens: numericFlag('--cached-input-tokens'),
          outputTokens: numericFlag('--output-tokens'),
          reasoningTokens: numericFlag('--reasoning-tokens'),
          durationMs: numericFlag('--duration-ms'),
        });
        if (!matched) {
          console.error(`heddle: row #${id} is not an unreported in-session handoff — nothing recorded`);
          process.exit(1);
        }
        out(json, { id, matched: true }, () => `reported in-session outcome for #${id} (${ok ? 'ok' : 'failed'})`);
        break;
      }
      const rows = new Ledger().recent(Number(arg('--limit') ?? 20), arg('--issue'));
      out(json, rows, () => rows.length
        ? rows.map((r) => `${r.ok ? '✓' : '✗'} #${r.id} ${r.task_class} ${r.provider}/${r.model}` +
            (r.issue ? ` ${r.issue}` : '') +
            (r.duration_ms ? ` ${(Number(r.duration_ms) / 1000).toFixed(1)}s` : '') +
            ` in=${r.input_tokens ?? '?'} out=${r.output_tokens ?? '?'}`).join('\n')
        : '(ledger empty)');
      break;
    }

    case 'reviews': {
      const ledger = new Ledger();
      const pairs = ledger.reviewPairStats();
      const recent = ledger.recentReviews(Number(arg('--limit') ?? 10));
      out(json, { pairs, recent }, () => (pairs.length
        ? 'author → reviewer        reviews scored findings accepted rate   mandate-viol\n' + pairs.map((p) =>
            `${String(p.author_provider ?? '?').padEnd(7)} → ${String(p.reviewer_provider).padEnd(9)} ` +
            `${String(p.reviews).padStart(7)} ${String(p.scored).padStart(6)} ${String(p.findings_total).padStart(8)} ` +
            `${String(p.findings_accepted).padStart(8)} ${p.acceptance_rate === null ? '   —' : String(p.acceptance_rate).padStart(5)} ` +
            `${String(p.mandate_violations).padStart(12)}`).join('\n')
        : '(no adversarial reviews yet)') +
        (recent.length ? '\n\nrecent:\n' + recent.map((r) => `#${r.dispatch_id} ${r.author_provider ?? '?'} → ${r.reviewer_provider}/${r.reviewer_model}` +
            (r.mandate_ok === 0 ? '  [MANDATE VIOLATION]' : '') +
            (r.outcome_at ? `  ${r.findings_accepted}/${r.findings_total} accepted` : '  (unscored)') +
            (r.issue ? `  ${r.issue}` : '')).join('\n') : ''));
      break;
    }

    case 'review-outcome': {
      const id = Number(process.argv[3]);
      const total = Number(arg('--total'));
      const accepted = Number(arg('--accepted'));
      if (!Number.isInteger(id) || !Number.isInteger(total) || !Number.isInteger(accepted)) {
        console.error('usage: heddle review-outcome <dispatch-id> --total N --accepted M [--notes "…"]');
        process.exit(2);
      }
      const ledger = new Ledger();
      if (!ledger.recordReviewOutcome(id, { findingsTotal: total, findingsAccepted: accepted, notes: arg('--notes') })) {
        console.error(`heddle: no review row for dispatch #${id} (was it an adversarial-review dispatch?)`);
        process.exit(1);
      }
      out(json, ledger.getReview(id), () => `recorded #${id}: ${accepted}/${total} findings accepted`);
      break;
    }

    case 'usage': {
      const ledger = new Ledger();
      const rows = ledger.usageByProvider(arg('--since'));
      // HED-25: classifier spend is REAL spend, reported separately so it is visible without
      // inflating worker dispatch counts or the savings math.
      const cls = ledger.classificationUsage(arg('--since'));
      // JSON stays an ARRAY of provider rows — heddle-dashboard's heddle_stats parses this shape,
      // and quietly turning it into an object would break a consumer for cosmetics. Classification
      // spend rides the human-readable output, and `--classifications` gives it to JSON callers.
      out(json, has('--classifications') ? cls : rows, () => {
        const workers = rows.length
          ? rows.map((r) => `${String(r.provider).padEnd(8)} ${r.dispatches} dispatches, ` +
              `${r.succeeded} ok, in=${r.input_tokens} (cached ${r.cached_tokens}) out=${r.output_tokens}`).join('\n')
          : '(no usage recorded yet)';
        if (!cls.length) return workers;
        const clsLines = cls.map((r) => `  ${String(r.kind).padEnd(16)} ${String(r.provider)}/${String(r.model)} ` +
          `${r.runs} runs, in=${r.input_tokens} out=${r.output_tokens}`).join('\n');
        return `${workers}\n\nclassifiers (not worker dispatches):\n${clsLines}`;
      });
      break;
    }

    case 'projects': {
      const reg = loadProjectRegistry();
      out(json, reg, () => reg.projects.length
        ? reg.projects.map((p) =>
            `${p.name.padEnd(14)} team:${p.linearTeam}  room:${p.defaultRoom}  launcher:${p.launcher}\n` +
            `${''.padEnd(15)}agents: ${p.agentIds.join(' ')}\n` +
            `${''.padEnd(15)}roots:  ${p.workspaceRoots.join(', ')}`).join('\n\n')
        : existsSync(DEFAULT_PROJECTS_PATH)
          ? `(${DEFAULT_PROJECTS_PATH} is present but registers no projects)`
          : `(no projects registered — ${DEFAULT_PROJECTS_PATH} is absent; consumers fall back to cwd inference. See docs/PROJECTS.md to populate it.)`);
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  const message = (err as Error).message ?? String(err);
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`heddle: ${message}`);
  process.exit(1);
}
