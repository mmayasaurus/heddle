import { spawn } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';
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
 * Default headless tool allowlist — the codex-workspace-write analog: read/edit the workspace, run the
 * repo's own scripts and inspect git; no network tools, no arbitrary shell. Tunable via the routing
 * YAML (`providers.claude.headless.allowed_tools`); `browse` appends WebFetch/WebSearch.
 */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'TodoWrite',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)', 'Bash(node:*)',
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
  let result: any;
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.type === 'result') { result = parsed; break; }
    } catch { /* keep scanning */ }
  }
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
  const output = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
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
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.systemPromptAppend) args.push('--append-system-prompt', opts.systemPromptAppend);
    // ALWAYS strict: a worker sees only the MCP servers heddle attached (the dispatcher writes an
    // empty config when none) — never the operator's global servers (Serena can EDIT code, Linear /
    // Supabase / argent act on live systems). Verified live 2026-08-15: without this a `--tools
    // Read,Grep,Glob` "read-only" reviewer still had Serena's replace_content available.
    if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
    if (opts.readOnly) {
      // HED-3 reviewers: only the read built-ins exist for the session — no Edit/Write/Bash at all
      // (`--tools` restricts the built-in set; verified live: Write reported disabled, no file created).
      args.push('--tools', 'Read', 'Grep', 'Glob', '--permission-mode', 'acceptEdits');
    } else if (caps.has('exec-privileged')) {
      args.push('--dangerously-skip-permissions');
    } else {
      const tools = [...this.allowedTools, ...(caps.has('browse') ? ['WebFetch', 'WebSearch'] : [])];
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...tools);
    }
    args.push(...(opts.extraFlags ?? []));
    return args;
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const args = this.buildArgs(prompt, opts);
    const started = Date.now();
    const { stdout, stderr, exitCode } = await run(this.bin, args, opts.cwd, opts.timeoutMs ?? 600_000, opts.env, opts.envUnset);
    const parsed = parseClaudeResult(stdout, exitCode);
    if (!parsed.ok && parsed.error && !parsed.raw) {
      parsed.error += `; stderr tail: ${stderr.slice(-400)}`;
    }
    return { ...parsed, durationMs: parsed.durationMs ?? Date.now() - started };
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number,
             envOverrides?: Record<string, string>, envUnset?: string[]):
  Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // stdin 'ignore' — same discipline as every subprocess adapter (see codex.ts).
    const { env } = buildWorkerEnv({ overrides: envOverrides, unset: envUnset });
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\nspawn error: ${String(err)}`, exitCode: null });
    });
  });
}
