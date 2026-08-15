#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dispatch } from './dispatch.js';
import { Ledger } from './ledger.js';
import { loadRouting, describeTaskClasses } from './routing.js';
import { listPacks, withMandatoryPacks } from './skillpacks.js';
import { classifyEffort, assessResult } from './classify.js';
import { resolveIdentity } from './identity.js';

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

// Identity is bound ONCE, from this process's environment (HEDDLE_AGENT / FLEET_AGENT / .fleet-agent),
// never from a tool argument — HED-65. If this server was started inside a heddle worker
// (HEDDLE_WORKER=1) every dispatch is refused with `depth-1` (src/identity.ts, src/dispatch.ts).
const IDENTITY = resolveIdentity();

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorText(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

server.tool(
  'dispatch_worker',
  'Dispatch one sub-task to a best-fit worker model and return its result. Use a task class ' +
    '(preferred — it carries the routing policy: default skills/mcp, opt-in gate), OR name ' +
    'provider+model directly, OR both (class = policy, named model = route, no fallback). Workers ' +
    'run on subscription CLIs as subprocesses; this call blocks until the worker finishes (seconds ' +
    'to minutes). Returns {ok, output, provider, model, skills, sessionId (resume handle), usage, ' +
    'ledgerId}. Claude-primary classes (execution in-session-subagent) are NOT spawned: you get ' +
    '{ok:false, refusal:{code:"claude-in-session", instruction}} — run them with your own Agent ' +
    'tool as instructed, or name a subprocess provider+model.',
  {
    prompt: z.string().describe('The sub-task instructions for the worker.'),
    task_class: z.string().optional().describe('Routing task class (see list_task_classes) — supplies policy. Alone: the table\'s route. With provider+model: the named route under this class\'s policy.'),
    provider: z.string().optional().describe('Explicit route: codex | cursor | gemini. Requires model. Without task_class = direct path.'),
    model: z.string().optional().describe('Explicit route: model id for provider (e.g. cursor-grok-4.6-high).'),
    cwd: z.string().optional().describe('Working directory for the worker (default: server cwd).'),
    issue: z.string().optional().describe('Linear issue this sub-task serves, e.g. SPI-712.'),
    agent: z.string().optional().describe("Dispatching orchestrator's fleet identity, e.g. K — used only when this heddle process has no bound identity (HEDDLE_AGENT/FLEET_AGENT/.fleet-agent); a bound identity always wins and the result says which."),
    skills: z.array(z.string()).optional().describe(
      'Skill packs to load (see list_skill_packs). Omit to get the task class\'s default packs ' +
      '(the `skills` column of list_task_classes); an explicit list REPLACES that default. ' +
      '`worker-role` is always included either way.'),
    mcp: z.array(z.string()).optional().describe('Code-discovery MCP servers to attach, e.g. ["memtrace"].'),
    effort: z.string().optional().describe('Reasoning effort: codex minimal|low|medium|high|xhigh; agy low|medium|high.'),
    auto_effort: z.boolean().optional().describe('Classify the sub-task difficulty (cheap model) and pin effort automatically, if effort not set.'),
    resume: z.string().optional().describe('Resume a prior worker session by its sessionId.'),
    codex_home: z.string().optional().describe('Account selection for codex workers (CODEX_HOME path).'),
    opt_in: z.boolean().optional().describe('Required for task classes gated behind explicit opt-in, and to grant the exec-privileged capability.'),
    capabilities: z.array(z.string()).optional().describe(
      'Capabilities to GRANT the worker: net | browse | exec-privileged (default: none — default-deny). ' +
      'Grants are ledgered and passed only to a provider whose CLI can enforce them (codex); an ' +
      'unenforceable or unknown grant is refused (refusal.code=capability-denied).'),
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
        capabilities: a.capabilities,
        identity: IDENTITY,
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
  'List routing task classes with dispatch-time guidance: where each routes (provider/model, ' +
    'execution, effort, fallback, opt-in), WHY to pick it, the default skill packs a dispatch gets ' +
    'when you omit `skills`, its default MCP servers, and whether its workers edit code. Consult ' +
    'this to pick the right class — fit and cost, not a favorite model — before dispatching. ' +
    '`execution: in-session-subagent` means use your own Agent tool with the routed model.',
  {},
  async () => {
    try {
      const rows = describeTaskClasses(loadRouting(), withMandatoryPacks);
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
  'List dispatches still in flight (started, not yet finished) for this heddle instance, plus this ' +
    "server's bound identity (who dispatches are attributed to) and whether it is running inside a worker.",
  {},
  async () => text({ identity: IDENTITY, in_flight: new Ledger().inFlight() }),
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
