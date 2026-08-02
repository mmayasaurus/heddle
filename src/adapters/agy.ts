import { spawn } from 'node:child_process';
import type { DispatchOptions, WorkerAdapter, WorkerResult, TokenUsage } from '../types.js';

/**
 * Antigravity CLI adapter — `agy -p --output-format stream-json`.
 *
 * Gemini models on a personal Google subscription (official client, OAuth, quota-billed).
 * Status: PILOTING — see docs/LANDMINES.md. Invocation contract (live-verified 2026-08-01,
 * agy 1.1.9, macOS):
 *  - Solo AND 3-concurrent (+codex+cursor neighbors) headless runs verified clean; upstream
 *    #573 (concurrency hang) did NOT reproduce on 1.1.9, but this adapter stays defensive:
 *    hard timeout, status-field check, model-echo verification, non-empty output required.
 *  - stream-json emits events incl. one carrying `model` (echoes the ACTUAL model used —
 *    detects upstream silent-Flash-fallback #710) and a final
 *    {event:"result", result:{status, response, conversation_id, usage{input_tokens,
 *    output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}}.
 *  - Resume: `--conversation <id>`. Effort is baked into model slugs (…-low/-medium/-high).
 *  - Policy: gemini-* slugs ONLY — agy's catalog also lists claude- and gpt-oss- third-party
 *    models; direct-subscription families never route through a middleman.
 */
/** Retry probe ceiling for the #573 hang check — a hung agy emits nothing, so this is ample. */
const RETRY_PROBE_MS = 120_000;

/**
 * Serializes dispatches per conversation id. Overlapping calls against the SAME conversation
 * trigger a known session-lock hang inside agy itself (documented by the tphakala/agy-mcp
 * maintainer). Resume-heavy orchestration would hit this constantly, so the adapter queues
 * same-conversation work instead of racing it. Different conversations still run in parallel.
 */
const conversationLocks = new Map<string, Promise<void>>();

async function withConversationLock<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!id) return fn();
  const prior = conversationLocks.get(id) ?? Promise.resolve();
  const result = prior.then(fn, fn); // run once the prior call settles, success or failure
  const chain = result.then(
    () => undefined,
    () => undefined, // swallow here so one failure can't poison the queue for later waiters
  );
  conversationLocks.set(id, chain);
  try {
    return await result;
  } finally {
    if (conversationLocks.get(id) === chain) conversationLocks.delete(id);
  }
}

export class AgyAdapter implements WorkerAdapter {
  readonly name = 'agy';
  readonly provider = 'gemini' as const;

  constructor(
    private readonly bin = 'agy',
    /** Unattended workers in isolated worktrees skip permission prompts; set false to keep
     *  agy's default prompting (which can hang a headless run — see LANDMINES). */
    private readonly skipPermissions = true,
  ) {}

  dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    return withConversationLock(opts.resume, () => this.execute(prompt, opts));
  }

  private async execute(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    if (!opts.model.startsWith('gemini-')) {
      return {
        ok: false, output: '', exitCode: null,
        error: `policy: agy adapter only routes gemini-* models (got "${opts.model}")`,
      };
    }

    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', opts.model];
    if (this.skipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.resume) args.push('--conversation', opts.resume);
    args.push(...(opts.extraFlags ?? []));

    const budget = opts.timeoutMs ?? 600_000;
    const started = Date.now();
    let { stdout, stderr, exitCode, timedOut } = await run(this.bin, args, opts.cwd, budget);

    // Upstream #573: agy -p can hang indefinitely with zero output when several other
    // long-running CLI agent processes are active (contention in startup/handshake; staggered
    // starts do NOT help; solo is 100% reliable). Filed against 1.1.0, still open. A timeout with
    // no output matches that signature exactly — retry once, since contention is transient.
    if (timedOut && stdout.trim().length === 0) {
      // Cap the retry: a hung agy emits nothing, so a short probe is enough to confirm, and this
      // keeps a double-hang from burning two full budgets (2×10min at the default).
      const retryBudget = Math.min(budget, RETRY_PROBE_MS);
      ({ stdout, stderr, exitCode, timedOut } = await run(this.bin, args, opts.cwd, retryBudget));
      if (timedOut && stdout.trim().length === 0) {
        return {
          ok: false, output: '', exitCode, durationMs: Date.now() - started,
          error: `agy produced no output in ${budget}ms, nor in a ${retryBudget}ms retry probe — ` +
            `matches upstream #573 concurrency-hang signature; route to a fallback provider`,
        };
      }
    }

    const durationMs = Date.now() - started;

    if (stdout.trim().length === 0) {
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `agy produced no stdout (exit ${exitCode}, timedOut=${timedOut}); ` +
          `stderr tail: ${stderr.slice(-400)}`,
      };
    }

    let reportedModel: string | undefined;
    let result: any;
    const events: unknown[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      events.push(ev);
      if (typeof ev.model === 'string') reportedModel = ev.model;
      if (ev.event === 'result' && ev.result) result = ev.result;
    }

    if (!result) {
      // Partial output + timeout = a legitimately slow task, NOT the #573 hang (which produces
      // nothing at all). Deliberately not retried — raise the budget or route elsewhere instead
      // of burning a second full timeout.
      return {
        ok: false, output: '', exitCode, durationMs,
        error: timedOut
          ? `agy timed out after ${budget}ms with partial output and no result event — ` +
            `task likely needs a larger timeoutMs (not the #573 hang signature)`
          : `no result event from agy (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
        raw: events,
      };
    }

    const usage: TokenUsage | undefined = result.usage
      ? {
          inputTokens: result.usage.input_tokens,
          cachedInputTokens: result.usage.cache_read_tokens,
          outputTokens: result.usage.output_tokens,
          reasoningOutputTokens: result.usage.thinking_tokens,
        }
      : undefined;

    const modelMismatch = reportedModel !== undefined && reportedModel !== opts.model;
    const response = typeof result.response === 'string' ? result.response.trim() : '';
    const ok = exitCode === 0 && result.status === 'SUCCESS' && response.length > 0 && !modelMismatch;

    return {
      ok,
      output: response,
      sessionId: result.conversation_id,
      usage,
      durationMs,
      exitCode,
      error: ok ? undefined
        : modelMismatch
          ? `model fallback detected: requested "${opts.model}" but agy ran "${reportedModel}" (upstream #710 class)`
          : `agy status=${result.status} (exit ${exitCode})`,
      raw: events,
    };
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    // stdin 'ignore' — same discipline as every subprocess adapter (see codex.ts).
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\nspawn error: ${String(err)}`, exitCode: null, timedOut });
    });
  });
}
