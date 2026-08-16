/**
 * Worker adapter contract (ports-and-adapters).
 *
 * One adapter per CLI. Adapters own: launch-command construction, instruction injection,
 * structured-output parsing, and resume handles. They never own routing decisions (routing
 * table) or messaging (broker, Phase 2).
 */

export interface DispatchOptions {
  /** Model id in the target CLI's own naming (see routing/routing.v0.yaml snapshots). */
  model: string;
  /** Working directory the worker runs in (usually a git worktree). */
  cwd: string;
  /**
   * Reasoning effort. Interpreted per provider: codex → `-c model_reasoning_effort`
   * (minimal|low|medium|high|xhigh); agy → `--effort` (low|medium|high). Cursor encodes effort in
   * the model id (…-low/-medium/-high) so it ignores this. Omit to use the model's default.
   */
  effort?: string;
  /** Extra CLI flags the routing table attaches to a task class (e.g. slim-context flags). */
  extraFlags?: string[];
  /** Hard wall-clock limit; adapters kill the child past this. */
  timeoutMs?: number;
  /** Resume a prior session/thread instead of starting fresh. */
  resume?: string;
  /**
   * Environment overrides for this dispatch — the account-rotation hook plus heddle's own worker
   * stamps (HEDDLE_WORKER / HEDDLE_DISPATCH_ID / HEDDLE_PARENT). Accepts subscription identity
   * selectors (CODEX_HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, CURSOR_API_KEY); API-key vars
   * are refused by buildWorkerEnv(). See src/env.ts.
   */
  env?: Record<string, string>;
  /**
   * Capabilities GRANTED to this worker (already decided by src/capabilities.ts — the adapter only
   * maps them to flags it can enforce; it never receives one it cannot). Empty/absent = default-deny.
   */
  capabilities?: string[];
  /** Env vars to REMOVE from the worker env (e.g. CLAUDE_CONFIG_DIR for the default Claude account). */
  envUnset?: string[];
  /** Skill packs as text for CLIs that take instructions on the command line (claude --append-system-prompt). */
  systemPromptAppend?: string;
  /** Path to a per-dispatch MCP config file for CLIs that read one (claude --mcp-config). */
  mcpConfigPath?: string;
  /** HED-3: the worker must not change the worktree — adapters pass a read-only sandbox where the CLI has one. */
  readOnly?: boolean;
  /** Names of the MCP servers in mcpConfigPath — claude allowlists them as `mcp__<name>`. */
  mcpServers?: string[];
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface WorkerResult {
  ok: boolean;
  /** Final agent message (the deliverable text). */
  output: string;
  /** Provider-native resume handle (codex thread_id, cursor session_id, …). */
  sessionId?: string;
  usage?: TokenUsage;
  durationMs?: number;
  exitCode: number | null;
  /** Populated on failure: what went wrong, adapter-diagnosed. */
  error?: string;
  /** Raw structured output for the ledger/dashboard; never parse downstream — use fields above. */
  raw?: unknown;
}

export interface WorkerAdapter {
  readonly name: string;
  readonly provider: 'codex' | 'cursor' | 'claude' | 'gemini';
  dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult>;
}
