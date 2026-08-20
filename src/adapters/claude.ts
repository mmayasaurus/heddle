import { lastResultJson } from './parse.js';
import { run } from './subprocess.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult, TokenUsage } from '../types.js';

/**
 * Claude Code adapter — `claude -p --output-format json` (HED-78, Maya's "build the auto account
 * switching", 2026-08-15).
 *
 * Two ways heddle can run Claude work:
 *  - **in-session** (the original protocol): the orchestrator's own Agent-tool subagent — shares the
 *    orchestrator's prompt cache and account. Still available: `dispatch_worker(in_session: true)`
 *    returns the structured `claude-in-session` instruction instead of spawning.
 *  - **out-of-process** (this adapter): a headless `claude -p` subprocess under
 *    `CLAUDE_CONFIG_DIR=<account dir>` chosen by src/capaware.ts `pickClaudeAccount()` — the account
 *    with the most 5h headroom — which is what makes account rotation automatic.
 *
 * Invocation contract (verified live 2026-08-15, Claude Code 2.1.232 — docs/LANDMINES.md):
 *  - `--output-format json` prints ONE JSON object: {type:"result", subtype:"success"|…, is_error,
 *    result, session_id, duration_ms, num_turns, usage:{input_tokens, output_tokens,
 *    cache_read_input_tokens, cache_creation_input_tokens, output_tokens_details:{thinking_tokens}}}.
 *  - `--resume <session_id>` continues a session (cwd-scoped; `--mcp-config` etc. must be re-passed
 *    on every call — heddle always re-passes). `--no-session-persistence` is NOT used (it kills resume).
 *  - `--permission-mode auto` ABORTS a headless session after repeated classifier blocks (LANDMINES),
 *    so the default posture is `--permission-mode acceptEdits` + an explicit `--allowedTools` list;
 *    the `exec-privileged` capability (operator YAML switch + call opt-in) maps to
 *    `--dangerously-skip-permissions`; `browse` adds WebFetch/WebSearch to the allowlist; `net` has
 *    no knob (no sandbox) and is refused upstream by src/capabilities.ts.
 *  - NEVER `--bare` (cannot use subscription auth → would force API-key billing). buildWorkerEnv()
 *    strips ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL so the subscription OAuth of the config dir is
 *    the only credential a worker can use.
 *  - Skill packs are delivered via `--append-system-prompt` (no file written into the worktree — no
 *    AGENTS.md race for Claude workers); MCP via `--mcp-config <tmp json> --strict-mcp-config`.
 *  - stdin is closed ('ignore'); exit 0 with empty stdout is a FAILURE, never success.
 */
export const CLAUDE_WORKER_PROTOCOL_VERSION = 1;

/** Task classes the routing table sends to Claude, for reference by generators. */
export type ClaudeWorkerModel = 'fable' | 'opus' | 'sonnet' | 'haiku';

/**
 * Default headless tool allowlist — the codex-workspace-write analog: read/edit the workspace, run
 * the repo's own scripts and inspect git. This is a guardrail against ACCIDENTAL damage and drift,
 * NOT a security boundary: an edit-capable worker can stage code that runs under `npm run`/`npx`,
 * so network side effects cannot be truly fenced here (`net` is refused upstream because Claude has
 * no sandbox knob — see src/capabilities.ts; several PR-#12 reviewers flagged this, and the honest
 * answer is that the enforceable posture is the read-only reviewer one: `--tools Read Grep Glob`).
 * Raw `Bash(node:*)` is deliberately NOT granted — repo workflows go through npm/npx entries.
 * Tunable via the routing YAML (`providers.claude.headless.allowed_tools`); `browse` appends
 * WebFetch/WebSearch; attached MCP servers get their `mcp__<name>` tools appended per dispatch.
 */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'TodoWrite',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(rg:*)', 'Bash(grep:*)',
  'Bash(find:*)', 'Bash(pwd)', 'Bash(sed -n:*)',
] as const;

export interface ClaudeAdapterOptions {
  bin?: string;
  /** Allowlist for the acceptEdits posture (default: DEFAULT_CLAUDE_ALLOWED_TOOLS). */
  allowedTools?: readonly string[];
}

/** Parsed view of the single JSON result — pure, so the contract is unit-testable. */
export function parseClaudeResult(stdout: string, exitCode: number | null): WorkerResult {
  if (stdout.trim().length === 0) {
    return { ok: false, output: '', exitCode, error: `claude produced no stdout (exit ${exitCode})` };
  }
  const result: any = lastResultJson(stdout);
  if (!result) {
    return { ok: false, output: '', exitCode, error: `no result JSON from claude (exit ${exitCode}); stdout tail: ${stdout.slice(-400)}` };
  }
  const u = result.usage ?? {};
  const usage: TokenUsage | undefined = Object.keys(u).length
    ? {
        inputTokens: u.input_tokens,
        cachedInputTokens: u.cache_read_input_tokens,
        outputTokens: u.output_tokens,
        reasoningOutputTokens: u.output_tokens_details?.thinking_tokens,
      }
    : undefined;
  // A missing/null result field is EMPTY output (ok=false below) — stringifying it would fabricate
  // a non-empty '""'/'null' that slips past the empty-result failure check.
  const output = typeof result.result === 'string' ? result.result
    : result.result == null ? ''
    : JSON.stringify(result.result);
  const ok = exitCode === 0 && result.is_error !== true && result.subtype === 'success' && output.length > 0;
  return {
    ok,
    output,
    sessionId: result.session_id,
    usage,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    exitCode,
    error: ok ? undefined
      : `claude ${result.subtype ?? 'result'} is_error=${result.is_error === true} (exit ${exitCode})` +
        (output.length === 0 ? ' — empty result' : ''),
    raw: result,
  };
}

export class ClaudeAdapter implements WorkerAdapter {
  readonly name = 'claude';
  readonly provider = 'claude' as const;
  private readonly bin: string;
  private readonly allowedTools: readonly string[];

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.allowedTools = opts.allowedTools ?? DEFAULT_CLAUDE_ALLOWED_TOOLS;
  }

  /** The exact argv for one dispatch — pure, so tests can pin the invocation contract. */
  buildArgs(prompt: string, opts: DispatchOptions): string[] {
    const caps = new Set(opts.capabilities ?? []);
    const args = ['-p', prompt, '--output-format', 'json', '--model', opts.model];
    // classify_effort can emit 'minimal' (codex vocabulary); claude accepts low|medium|high|xhigh|max.
    const effort = opts.effort === 'minimal' ? 'low' : opts.effort;
    if (effort) args.push('--effort', effort);
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.systemPromptAppend) args.push('--append-system-prompt', opts.systemPromptAppend);
    // ALWAYS strict: a worker sees only the MCP servers heddle attached (the dispatcher writes an
    // empty config when none) — never the operator's global servers (Serena can EDIT code, Linear /
    // Supabase / argent act on live systems). Verified live 2026-08-15: without this a `--tools
    // Read,Grep,Glob` "read-only" reviewer still had Serena's replace_content available.
    if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
    if (opts.readOnly) {
      // HED-3 reviewers: only the read built-ins exist in the TOOL SET — no Edit/Write/Bash at all.
      // `--tools` (set restriction) is the ONLY mechanism verified to hold (live, 2026-08-15,
      // twice): a permission-layer allowlist is NOT a boundary — a probe with `--tools … Bash` +
      // `--allowedTools Bash(git …)` still appended to a tracked file and created a new one,
      // because the OPERATOR's global settings.json permission allows leak into workers (the same
      // class of leak as the global MCP one; see docs/LANDMINES.md). Reviewers therefore cannot
      // run git — a diff_base review gets the diff EMBEDDED in its prompt (src/dispatch.ts).
      // A granted `browse` keeps WebFetch/WebSearch (set-level, so it actually holds); MCP tools
      // are governed by the per-dispatch --strict-mcp-config file, not --tools.
      args.push('--tools', 'Read', 'Grep', 'Glob', ...(caps.has('browse') ? ['WebFetch', 'WebSearch'] : []), '--permission-mode', 'acceptEdits');
    } else if (caps.has('exec-privileged')) {
      args.push('--dangerously-skip-permissions');
    } else {
      // Attached MCP servers must ALSO be allowlisted (mcp__<server> = every tool it serves) —
      // --strict-mcp-config makes them available, but headless has no prompt to approve them.
      const tools = [
        ...this.allowedTools,
        ...(caps.has('browse') ? ['WebFetch', 'WebSearch'] : []),
        ...(opts.mcpServers ?? []).map((s) => `mcp__${s}`),
      ];
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...tools);
    }
    args.push(...(opts.extraFlags ?? []));
    return args;
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const args = this.buildArgs(prompt, opts);
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const { stdout, stderr, exitCode, timedOut } = await run(this.bin, args, opts.cwd, timeoutMs, opts.env, opts.envUnset);
    const parsed = parseClaudeResult(stdout, exitCode);
    // A timeout must be tellable apart from a crash: SIGKILL alone reports only a null exit.
    if (timedOut) parsed.error = `claude timed out after ${timeoutMs}ms (SIGKILL)` + (parsed.error ? `; ${parsed.error}` : '');
    // stderr often carries the useful context even when a result JSON WAS parsed (e.g. error
    // subtypes with an empty result) — attach the tail on every failure.
    if (!parsed.ok && parsed.error && stderr.trim().length) {
      parsed.error += `; stderr tail: ${stderr.slice(-400)}`;
    }
    return { ...parsed, durationMs: parsed.durationMs ?? Date.now() - started };
  }
}
