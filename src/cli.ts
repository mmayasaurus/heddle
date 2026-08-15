#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// node:sqlite is stable enough for our use but still flagged experimental; the warning would
// pollute stdout parsing for agents, so it is suppressed at the entry point only —
// `--disable-warning=<type>` silences just that category (`--no-warnings` would hide every
// process warning; its `=…` suffix is ignored — verified Node 22.23, 2026-08-15).
import { dispatch, planDispatch } from './dispatch.js';
import { Ledger } from './ledger.js';
import { loadRouting, describeTaskClasses } from './routing.js';
import { listPacks, withMandatoryPacks } from './skillpacks.js';
import { classifyEffort, assessResult } from './classify.js';
import { resolveIdentity } from './identity.js';

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
      --no-fallback        do not try the table's fallback on failure
      --capabilities a,b   GRANT worker capabilities: net | browse | exec-privileged (default: none)
      --json               machine-readable result

  heddle classify-effort --class <c> --task "<prompt>" [--json]   difficulty → effort (cheap model)
  heddle assess --task "<prompt>" --output "<worker output>" [--ok] [--json]
                                 judge a worker result: done | needs-rework | needs-human
  heddle route (--class <c> | --provider <p> --model <m>) [--class <c> --provider <p> --model <m>] [--opt-in] [--json]
                                 DRY RUN: where a dispatch would go right now and why (live caps, cap-aware
                                 routing, account advice) — no ledger row, no worker
  heddle classes [--json]        task classes: route, why, default skill packs, edits-code
  heddle packs                   list available skill packs
  heddle whoami [--json]         this process's bound identity (HEDDLE_AGENT / FLEET_AGENT / .fleet-agent) + worker context
  heddle workers [--stale <hours>] [--json]   dispatches still in flight (--stale: only orphans older than N hours)
  heddle ledger [--issue SPI-n] [--limit N] [--json]
  heddle ledger finish <id> --error "<why>"   close an orphaned in-flight row (ok=0)
  heddle usage [--since <iso>] [--json]    per-provider totals
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
        noFallback: has('--no-fallback'),
        capabilities: arg('--capabilities')?.split(',').map((s) => s.trim()).filter(Boolean),
      });

      const { raw, ...summary } = res;
      out(json, summary, () => {
        const head = `${res.ok ? '✓' : '✗'} ${res.taskClass} → ${res.provider}/${res.model}` +
          (res.usedFallback ? ' (fallback)' : '') +
          (res.refusal ? ` [refused: ${res.refusal.code}]` : '') +
          (res.durationMs ? ` · ${(res.durationMs / 1000).toFixed(1)}s` : '') +
          (res.sessionId ? `\n  resume: ${res.sessionId}` : '');
        return res.ok ? `${head}\n\n${res.output}` : `${head}\n  error: ${res.error}`;
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
      });
      const summary = {
        task_class: plan.route.taskClass,
        would_run: plan.decision.refusal ? null : `${plan.target.provider}/${plan.target.model}`,
        execution: plan.execution ?? null,
        in_session: plan.execution === 'in-session-subagent',
        routed_away_for_cap: plan.decision.routedAwayForCap,
        remaining_fallback: plan.fallback ? `${plan.fallback.provider}/${plan.fallback.model}` : null,
        route_reason: plan.decision.routeReason,
        refusal: plan.decision.refusal ?? null,
        checks: plan.decision.checks,
        account: plan.account,
        account_advice: plan.accountAdvice?.line ?? null,
        skills: plan.skillsForRefusal,
      };
      out(json, summary, () =>
        `${plan.route.taskClass}` +
        (summary.refusal ? `\n  ✗ WOULD REFUSE (${summary.refusal.code}): ${summary.refusal.reason}`
          : `\n  → ${summary.would_run}${summary.in_session ? '  [in-session: use your Agent tool]' : ''}` +
            (summary.routed_away_for_cap ? '  (routed away for cap)' : '')) +
        `\n  reason: ${summary.route_reason}` +
        (summary.remaining_fallback ? `\n  fallback if it fails: ${summary.remaining_fallback}` : '') +
        (summary.account_advice ? `\n  ${summary.account_advice}` : '') +
        `\n  checks:\n    - ${summary.checks.join('\n    - ')}`);
      break;
    }

    case 'classify-effort': {
      const taskClass = arg('--class') ?? 'general';
      const task = arg('--task') ?? (await readStdin());
      if (!task) { console.error('classify-effort requires --task (or piped stdin)'); process.exit(2); }
      const effort = await classifyEffort(taskClass, task, arg('--cwd') ?? process.cwd());
      out(json, { taskClass, effort }, () => effort);
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
        (r.edits_code ? '  [edits code]' : '') +
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
      const rows = new Ledger().recent(Number(arg('--limit') ?? 20), arg('--issue'));
      out(json, rows, () => rows.length
        ? rows.map((r) => `${r.ok ? '✓' : '✗'} #${r.id} ${r.task_class} ${r.provider}/${r.model}` +
            (r.issue ? ` ${r.issue}` : '') +
            (r.duration_ms ? ` ${(Number(r.duration_ms) / 1000).toFixed(1)}s` : '') +
            ` in=${r.input_tokens ?? '?'} out=${r.output_tokens ?? '?'}`).join('\n')
        : '(ledger empty)');
      break;
    }

    case 'usage': {
      const rows = new Ledger().usageByProvider(arg('--since'));
      out(json, rows, () => rows.length
        ? rows.map((r) => `${String(r.provider).padEnd(8)} ${r.dispatches} dispatches, ` +
            `${r.succeeded} ok, in=${r.input_tokens} (cached ${r.cached_tokens}) out=${r.output_tokens}`).join('\n')
        : '(no usage recorded yet)');
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
