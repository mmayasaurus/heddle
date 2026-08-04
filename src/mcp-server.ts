#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dispatch } from './dispatch.js';
import { Ledger } from './ledger.js';
import { loadRouting, listTaskClasses, resolveRoute } from './routing.js';
import { listPacks } from './skillpacks.js';
import { classifyEffort, assessResult } from './classify.js';

/**
 * heddle MCP server — the orchestration surface as MCP tools.
 *
 * This is what turns an orchestrator from "the operator runs heddle commands" into "the
 * orchestrator autonomously delegates": a Claude Code orchestrator with this server in its
 * .mcp.json calls `dispatch_worker` (and friends) as tools, so decompose→dispatch→integrate
 * happens inside its own agent loop.
 *
 * Register in an orchestrator's .mcp.json:
 *   { "mcpServers": { "heddle": { "command": "heddle-mcp" } } }
 * (or command: "node", args: ["<repo>/dist/mcp-server.js"]).
 */

const server = new McpServer({ name: 'heddle', version: '0.0.1' });

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorText(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

server.tool(
  'dispatch_worker',
  'Dispatch one sub-task to a best-fit worker model and return its result. Use a task class ' +
    '(preferred — it carries the routing policy) OR name provider+model directly. Workers run on ' +
    'subscription CLIs as subprocesses; this call blocks until the worker finishes (seconds to ' +
    'minutes). Returns {ok, output, provider, model, sessionId (resume handle), usage, ledgerId}.',
  {
    prompt: z.string().describe('The sub-task instructions for the worker.'),
    task_class: z.string().optional().describe('Routing task class (see list_task_classes). Use this OR provider+model.'),
    provider: z.string().optional().describe('Direct override: codex | cursor | gemini. Requires model.'),
    model: z.string().optional().describe('Direct override: model id for provider (e.g. cursor-grok-4.5-high).'),
    cwd: z.string().optional().describe('Working directory for the worker (default: server cwd).'),
    issue: z.string().optional().describe('Linear issue this sub-task serves, e.g. SPI-712.'),
    agent: z.string().optional().describe("Dispatching orchestrator's fleet identity, e.g. K."),
    skills: z.array(z.string()).optional().describe('Skill packs to load (see list_skill_packs).'),
    mcp: z.array(z.string()).optional().describe('Code-discovery MCP servers to attach, e.g. ["memtrace"].'),
    effort: z.string().optional().describe('Reasoning effort: codex minimal|low|medium|high|xhigh; agy low|medium|high.'),
    auto_effort: z.boolean().optional().describe('Classify the sub-task difficulty (cheap model) and pin effort automatically, if effort not set.'),
    resume: z.string().optional().describe('Resume a prior worker session by its sessionId.'),
    codex_home: z.string().optional().describe('Account selection for codex workers (CODEX_HOME path).'),
    opt_in: z.boolean().optional().describe('Required for task classes gated behind explicit opt-in.'),
    no_fallback: z.boolean().optional().describe('Do not try the routing table fallback on failure.'),
    timeout_ms: z.number().optional().describe('Wall-clock budget (default 600000).'),
  },
  async (a) => {
    try {
      const env: Record<string, string> = {};
      if (a.codex_home) env.CODEX_HOME = a.codex_home;
      const res = await dispatch({
        taskClass: a.task_class,
        provider: a.provider,
        model: a.model,
        prompt: a.prompt,
        cwd: a.cwd ?? process.cwd(),
        issue: a.issue,
        orchestrator: a.agent,
        skills: a.skills,
        mcp: a.mcp,
        effort: a.effort,
        autoEffort: a.auto_effort,
        resume: a.resume,
        env: Object.keys(env).length ? env : undefined,
        optIn: a.opt_in,
        noFallback: a.no_fallback,
        timeoutMs: a.timeout_ms,
      });
      const { raw, ...summary } = res;
      return text(summary);
    } catch (err) {
      return errorText(`dispatch failed: ${(err as Error).message ?? String(err)}`);
    }
  },
);

server.tool(
  'classify_effort',
  'Classify a sub-task\'s difficulty with a cheap model and return the reasoning-effort level ' +
    '(minimal|low|medium|high|xhigh). Use when unsure what effort a delegated task needs.',
  {
    task: z.string().describe('The sub-task to classify.'),
    task_class: z.string().optional().describe('The routing task class, for context.'),
    cwd: z.string().optional(),
  },
  async (a) => {
    try { return text({ effort: await classifyEffort(a.task_class ?? 'general', a.task, a.cwd) }); }
    catch (err) { return errorText(`classify_effort failed: ${(err as Error).message ?? String(err)}`); }
  },
);

server.tool(
  'assess_result',
  'Judge a worker\'s result with a cheap model: done | needs-rework | needs-human. `needs-human` ' +
    'means it is blocked on a decision/permission/ambiguity only the operator can resolve. Use to ' +
    'decide whether to accept, re-dispatch, or escalate a delegated result.',
  {
    task: z.string().describe('The sub-task the worker was given.'),
    output: z.string().describe("The worker's result/output."),
    worker_ok: z.boolean().optional().describe('Whether the worker itself reported success.'),
    cwd: z.string().optional(),
  },
  async (a) => {
    try { return text(await assessResult(a.task, a.output, a.worker_ok ?? true, a.cwd)); }
    catch (err) { return errorText(`assess_result failed: ${(err as Error).message ?? String(err)}`); }
  },
);

server.tool(
  'list_task_classes',
  'List routing task classes and where each routes (provider/model, fallback, opt-in). Consult ' +
    'this to pick the right class before dispatching.',
  {},
  async () => {
    try {
      const table = loadRouting();
      const rows = listTaskClasses(table).map((c) => {
        const r = resolveRoute(table, c);
        return {
          task_class: c, provider: r.provider, model: r.model,
          fallback: r.fallback ? `${r.fallback.provider}/${r.fallback.model}` : null,
          opt_in_required: r.requiresExplicitOptIn ?? false, note: r.note ?? null,
        };
      });
      return text(rows);
    } catch (err) {
      return errorText(`could not load routing table: ${(err as Error).message ?? String(err)}`);
    }
  },
);

server.tool(
  'list_skill_packs',
  'List available skill packs that can be passed to dispatch_worker via the `skills` field.',
  {},
  async () => text(listPacks()),
);

server.tool(
  'check_workers',
  'List dispatches still in flight (started, not yet finished) for this heddle instance.',
  {},
  async () => text(new Ledger().inFlight()),
);

server.tool(
  'recent_dispatches',
  'Recent dispatch history from the ledger (decision + outcome + usage), newest first. ' +
    'Filter by issue to see all sub-tasks for one Linear issue.',
  {
    issue: z.string().optional().describe('Filter to one Linear issue, e.g. SPI-712.'),
    limit: z.number().optional().describe('Max rows (default 20).'),
  },
  async (a) => text(new Ledger().recent(a.limit ?? 20, a.issue)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
