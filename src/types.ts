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
  /** Extra CLI flags the routing table attaches to a task class (e.g. slim-context flags). */
  extraFlags?: string[];
  /** Hard wall-clock limit; adapters kill the child past this. */
  timeoutMs?: number;
  /** Resume a prior session/thread instead of starting fresh. */
  resume?: string;
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
  readonly provider: 'codex' | 'cursor' | 'claude';
  dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult>;
}
