#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dispatch, planDispatch, summarizePlan } from './dispatch.js';
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

// One ledger handle per server process: node:sqlite connections are cheap but not free, and a
// long-lived MCP server polled by check_workers/recent_dispatches would otherwise accumulate them.
let LEDGER: Ledger | undefined;
function ledger(): Ledger {
  return (LEDGER ??= new Ledger());
}

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
    'ledgerId, account, routeReason}. Claude classes run as a headless `claude -p` worker on the ' +
    'registry account with the most 5h headroom (automatic account rotation); pass in_session:true to ' +
    'get {ok:false, refusal:{code:"claude-in-session", instruction}} and run it as your own Agent-tool ' +
    'subagent instead (shared prompt cache, same account).',
  {
    prompt: z.string().describe('The sub-task instructions for the worker.'),
    task_class: z.string().optional().describe('Routing task class (see list_task_classes) — supplies policy. Alone: the table\'s route. With provider+model: the named route under this class\'s policy.'),
    provider: z.string().optional().describe('Explicit route: claude | codex | cursor | gemini (the agy CLI). Requires model (both or neither). Without task_class = direct path. "claude" runs a headless claude -p worker on the best registry account (in_session:true instead returns the structured claude-in-session refusal to run it as your own Agent-tool subagent).'),
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
    author_provider: z.string().optional().describe('adversarial-review: the provider that AUTHORED the change (claude | codex | cursor | gemini). The reviewer will be a DIFFERENT provider (reviewer_pool); recorded on the review row for pair scoring.'),
    author_model: z.string().optional().describe('adversarial-review: the model that authored the change, if known (recorded for pair scoring).'),
    author_dispatch_id: z.number().optional().describe('adversarial-review: ledger id of the dispatch that produced the change, if any (lineage).'),
    diff_base: z.string().optional().describe('adversarial-review: a git ref; heddle prepends "review `git diff <ref>...HEAD`" to your prompt.'),
    in_session: z.boolean().optional().describe('Claude classes: return the in-session (Agent tool) instruction instead of spawning a headless claude worker.'),
    account_pin: z.string().optional().describe('Claude classes: pin a registry account id (~/.heddle/accounts.json); default = most 5h headroom.'),
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
        inSession: a.in_session,
        accountPin: a.account_pin,
        authorProvider: a.author_provider,
        authorModel: a.author_model,
        authorDispatchId: a.author_dispatch_id,
        diffBase: a.diff_base,
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
  'plan_dispatch',
  'DRY RUN of dispatch_worker: where a task class (or explicit provider+model) would run RIGHT NOW ' +
    'and why — live provider caps (route-away when the primary is near its cap, metered-pool ' +
    'refusals), whether it is in-session, and which Claude account has the most headroom. No ledger ' +
    'row, no worker. Use it to pick a class when caps are tight.',
  {
    task_class: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    opt_in: z.boolean().optional(),
    codex_home: z.string().optional(),
    in_session: z.boolean().optional(),
    account_pin: z.string().optional(),
    author_provider: z.string().optional(),
  },
  async (a) => {
    try {
      const env: Record<string, string> = {};
      if (a.codex_home) env.CODEX_HOME = a.codex_home;
      const plan = planDispatch({
        taskClass: a.task_class, provider: a.provider, model: a.model, prompt: '(dry run)',
        cwd: process.cwd(), optIn: a.opt_in, env: Object.keys(env).length ? env : undefined, identity: IDENTITY,
        inSession: a.in_session, accountPin: a.account_pin, authorProvider: a.author_provider,
      });
      return text(summarizePlan(plan));
    } catch (err) {
      return errorText(`plan_dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
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
  'record_review_outcome',
  'adversarial-review follow-up: after you (the author) triaged a reviewer\'s findings, record how many ' +
    'there were and how many you accepted. This is the score that tunes reviewer pairs ' +
    '(review_stats). Call it once per review dispatch (ledgerId of the dispatch_worker result).',
  {
    dispatch_id: z.number().describe('The review dispatch\'s ledgerId.'),
    findings_total: z.number().describe('How many findings the reviewer reported (from its VERDICT line).'),
    findings_accepted: z.number().describe('How many you accepted as real (fixed or agreed).'),
    notes: z.string().optional().describe('Optional: which were false positives and why.'),
  },
  async (a) => {
    try {
      const ok = ledger().recordReviewOutcome(a.dispatch_id, { findingsTotal: a.findings_total, findingsAccepted: a.findings_accepted, notes: a.notes });
      if (!ok) return errorText(`no review row for dispatch #${a.dispatch_id} — was it dispatched with the adversarial-review class?`);
      return text({ recorded: true, review: ledger().getReview(a.dispatch_id) });
    } catch (err) { return errorText(`record_review_outcome failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
);

server.tool(
  'report_in_session',
  'report the outcome of an in-session (claude-class) dispatch heddle handed back, so it counts in the ledger.',
  {
    id: z.number().int().describe('Ledger id returned by the in-session claude dispatch.'),
    ok: z.boolean().describe('Whether the in-session subagent completed successfully.'),
    error: z.string().optional().describe('Failure reason when ok is false.'),
    duration_ms: z.number().optional().describe('Elapsed wall-clock time in milliseconds.'),
    input_tokens: z.number().optional().describe('Input tokens used by the subagent.'),
    cached_input_tokens: z.number().optional().describe('Cached input tokens used by the subagent.'),
    output_tokens: z.number().optional().describe('Output tokens used by the subagent.'),
    reasoning_tokens: z.number().optional().describe('Reasoning tokens used by the subagent.'),
  },
  async (a) => {
    try {
      // The ledger guards this to the one reportable, still-refusal handoff state; a stale or wrong
      // id is deliberately a no-op rather than overwriting an independently recorded outcome.
      const matched = ledger().reportInSession(a.id, {
        ok: a.ok, error: a.error, durationMs: a.duration_ms, inputTokens: a.input_tokens,
        cachedInputTokens: a.cached_input_tokens, outputTokens: a.output_tokens,
        reasoningTokens: a.reasoning_tokens,
      });
      return text({ id: a.id, matched });
    } catch (err) { return errorText(`report_in_session failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
);

server.tool(
  'review_stats',
  'Adversarial-review scoreboard: per author→reviewer provider pair — reviews, scored reviews, findings, ' +
    'accepted findings, acceptance rate, mandate violations — plus the most recent reviews. Use it to pick ' +
    'the reviewer family that finds real problems for a given author family.',
  { limit: z.number().int().min(1).max(100).optional().describe('Recent reviews to include (default 10, max 100).') },
  async (a) => {
    try {
      return text({ pairs: ledger().reviewPairStats(), recent: ledger().recentReviews(a.limit ?? 10) });
    } catch (err) { return errorText(`review_stats failed: ${err instanceof Error ? err.message : String(err)}`); }
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
  async () => text({ identity: IDENTITY, in_flight: ledger().inFlight() }),
);

server.tool(
  'recent_dispatches',
  'Recent dispatch history from the ledger (decision + outcome + usage), newest first. ' +
    'Filter by issue to see all sub-tasks for one Linear issue.',
  {
    issue: z.string().optional().describe('Filter to one Linear issue, e.g. SPI-712.'),
    limit: z.number().optional().describe('Max rows (default 20).'),
  },
  async (a) => text(ledger().recent(a.limit ?? 20, a.issue)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
