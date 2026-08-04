#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// node:sqlite is stable enough for our use but still flagged experimental; the warning would
// pollute stdout parsing for agents, so it is suppressed at the entry point only.
import { dispatch } from './dispatch.js';
import { Ledger } from './ledger.js';
import { loadRouting, listTaskClasses, resolveRoute } from './routing.js';
import { listPacks } from './skillpacks.js';

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
      --skills a,b         override the routing table's skill packs
      --mcp a,b            attach code-discovery MCP servers (e.g. memtrace)
      --effort <level>     reasoning effort: codex minimal|low|medium|high|xhigh; agy low|medium|high
      --resume <id>        continue a prior worker session
      --timeout <ms>       wall-clock budget (default 600000)
      --codex-home <path>  account selection for codex workers
      --opt-in             required for task classes that gate on it
      --no-fallback        do not try the table's fallback on failure
      --json               machine-readable result

  heddle classes [--json]        list task classes and where they route
  heddle packs                   list available skill packs
  heddle workers [--json]        dispatches still in flight
  heddle ledger [--issue SPI-n] [--limit N] [--json]
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
        resume: arg('--resume'),
        timeoutMs: arg('--timeout') ? Number(arg('--timeout')) : undefined,
        env: Object.keys(env).length ? env : undefined,
        optIn: has('--opt-in'),
        noFallback: has('--no-fallback'),
      });

      const { raw, ...summary } = res;
      out(json, summary, () => {
        const head = `${res.ok ? '✓' : '✗'} ${res.taskClass} → ${res.provider}/${res.model}` +
          (res.usedFallback ? ' (fallback)' : '') +
          (res.durationMs ? ` · ${(res.durationMs / 1000).toFixed(1)}s` : '') +
          (res.sessionId ? `\n  resume: ${res.sessionId}` : '');
        return res.ok ? `${head}\n\n${res.output}` : `${head}\n  error: ${res.error}`;
      });
      process.exit(res.ok ? 0 : 1);
      break;
    }

    case 'classes': {
      const table = loadRouting();
      const rows = listTaskClasses(table).map((c) => {
        const r = resolveRoute(table, c);
        return {
          taskClass: c, provider: r.provider, model: r.model,
          fallback: r.fallback ? `${r.fallback.provider}/${r.fallback.model}` : null,
          optInRequired: r.requiresExplicitOptIn ?? false, note: r.note ?? null,
        };
      });
      out(json, rows, () => rows.map((r) =>
        `${r.taskClass.padEnd(22)} ${r.provider}/${r.model}` +
        (r.fallback ? `  ↳ ${r.fallback}` : '') +
        (r.optInRequired ? '  [opt-in required]' : '')).join('\n'));
      break;
    }

    case 'packs': {
      const packs = listPacks();
      out(json, packs, () => packs.length ? packs.join('\n') : '(no skill packs yet)');
      break;
    }

    case 'workers': {
      const rows = new Ledger().inFlight();
      out(json, rows, () => rows.length
        ? rows.map((r) => `#${r.id} ${r.provider}/${r.model} ${r.task_class}` +
            (r.issue ? ` ${r.issue}` : '') + ` since ${r.started_at}`).join('\n')
        : '(nothing in flight)');
      break;
    }

    case 'ledger': {
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
