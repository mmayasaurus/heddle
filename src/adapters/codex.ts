import { spawn } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult, TokenUsage } from '../types.js';

/**
 * Codex CLI adapter — `codex exec --json`.
 *
 * Invocation contract (live-verified 2026-08-01, codex v0.144.1 — see docs/LANDMINES.md):
 *  - stdin MUST be closed ('ignore'): an open stdin pipe blocks codex forever on
 *    "Reading additional input from stdin...".
 *  - Output is NDJSON events; the deliverable is the last agent_message item, the resume
 *    handle is thread.started.thread_id, usage is on turn.completed.
 *  - exit 0 with empty stdout is a FAILURE (upstream #19945 class), never success.
 */
export class CodexAdapter implements WorkerAdapter {
  readonly name = 'codex';
  readonly provider = 'codex' as const;

  constructor(
    private readonly bin = 'codex',
    /** Sandbox for worker runs. Workers that edit files need workspace-write. */
    private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write',
    /** Run lean: skip the user's global ~/.codex config (fleet instructions, argent's ~90 tools,
     *  serena, node_repl…). Default true — a delegated worker should get ONLY the skill packs +
     *  the MCP servers it was given (supplied inline via codexMcpFlags). Also sheds the fleet
     *  claim-before-code policy that made an early worker refuse. Verified ~124k vs multi-100k input. */
    private readonly ignoreUserConfig = true,
  ) {}

  /**
   * The exact argv for one dispatch — pure, so tests can pin the invocation contract.
   * `approval_policy="never"` is load-bearing for headless work: without it, tool calls that
   * would otherwise prompt — notably MCP tool calls (memtrace/serena) — are auto-cancelled with
   * "user cancelled MCP tool call" because there is no TTY to approve them. `never` auto-proceeds
   * within the sandbox, which is the correct unattended-worker posture. `codex exec` takes this
   * via `-c` config override (there is no `--ask-for-approval` flag on the exec subcommand).
   * Capability grants (src/capabilities.ts) are the only flags that widen the default-deny posture:
   *  - exec-privileged: no sandbox at all (`danger-full-access`), operator-opted-in upstream;
   *  - net: workspace-write keeps outbound network OFF by default (official sandbox docs) —
   *    `sandbox_workspace_write.network_access=true` turns it on;
   *  - browse: `web_search` defaults to "cached" (OpenAI index, no external access); "live" is
   *    unrestricted retrieval.
   */
  buildArgs(prompt: string, opts: DispatchOptions): string[] {
    const caps = new Set(opts.capabilities ?? []);
    // read-only (HED-3 reviewers) wins over everything: a reviewer never gets a writable sandbox.
    const sandbox = opts.readOnly ? 'read-only' : caps.has('exec-privileged') ? 'danger-full-access' : this.sandbox;
    const args = ['exec', '--json', '--skip-git-repo-check',
      '--sandbox', sandbox, '-c', 'approval_policy="never"'];
    if (caps.has('net')) args.push('-c', 'sandbox_workspace_write.network_access=true');
    if (caps.has('browse')) args.push('-c', 'web_search="live"');
    if (this.ignoreUserConfig) args.push('--ignore-user-config');
    if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    if (opts.resume) args.push('resume', opts.resume);
    args.push('-m', opts.model, ...(opts.extraFlags ?? []), prompt);
    return args;
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const args = this.buildArgs(prompt, opts);

    const started = Date.now();
    const { stdout, stderr, exitCode } =
      await run(this.bin, args, opts.cwd, opts.timeoutMs ?? 600_000, opts.env);
    const durationMs = Date.now() - started;

    if (stdout.trim().length === 0) {
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `codex produced no stdout (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
      };
    }

    let sessionId: string | undefined;
    let usage: TokenUsage | undefined;
    let lastAgentMessage = '';
    let turnFailed: string | undefined;
    const events: unknown[] = [];

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      events.push(ev);
      if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
      if (ev.type === 'turn.completed' && ev.usage) {
        usage = {
          inputTokens: ev.usage.input_tokens,
          cachedInputTokens: ev.usage.cached_input_tokens,
          outputTokens: ev.usage.output_tokens,
          reasoningOutputTokens: ev.usage.reasoning_output_tokens,
        };
      }
      if (ev.type === 'turn.failed') turnFailed = JSON.stringify(ev).slice(0, 400);
      if (ev.type === 'error' && ev.message) turnFailed = String(ev.message);
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        lastAgentMessage = ev.item.text;
      }
    }

    const ok = exitCode === 0 && !turnFailed && lastAgentMessage.length > 0;
    return {
      ok,
      output: lastAgentMessage,
      sessionId,
      usage,
      durationMs,
      exitCode,
      error: ok ? undefined : (turnFailed ?? `no agent_message parsed (exit ${exitCode})`),
      raw: events,
    };
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number,
             envOverrides?: Record<string, string>):
  Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // stdin 'ignore' is load-bearing — see contract note above.
    const { env } = buildWorkerEnv({ overrides: envOverrides });
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
