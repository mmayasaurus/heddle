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
export class AgyAdapter implements WorkerAdapter {
  readonly name = 'agy';
  readonly provider = 'gemini' as const;

  constructor(
    private readonly bin = 'agy',
    /** Unattended workers in isolated worktrees skip permission prompts; set false to keep
     *  agy's default prompting (which can hang a headless run — see LANDMINES). */
    private readonly skipPermissions = true,
  ) {}

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
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

    const started = Date.now();
    const { stdout, stderr, exitCode } = await run(this.bin, args, opts.cwd, opts.timeoutMs ?? 600_000);
    const durationMs = Date.now() - started;

    if (stdout.trim().length === 0) {
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `agy produced no stdout (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
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
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `no result event from agy (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
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
  Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // stdin 'ignore' — same discipline as every subprocess adapter (see codex.ts).
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
