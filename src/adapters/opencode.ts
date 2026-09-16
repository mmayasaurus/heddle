import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../types.js';
import { failIfTruncated } from './parse.js';
import { run } from './subprocess.js';

/** Native OpenCode adapter (`opencode run --format json`). */
export class OpenCodeAdapter implements WorkerAdapter {
  readonly name = 'opencode';
  readonly provider = 'opencode' as const;

  constructor(private readonly bin = 'opencode') {}

  buildArgs(prompt: string, opts: DispatchOptions): string[] {
    const args = ['run', '--format', 'json', '--model', opts.model];
    if (opts.effort) args.push('--variant', opts.effort);
    if (opts.resume) args.push('--session', opts.resume);
    if (!opts.readOnly && opts.skipPermissions !== false) args.push('--dangerously-skip-permissions');
    args.push(...(opts.extraFlags ?? []), prompt);
    return args;
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const started = Date.now();
    const { stdout, stderr, exitCode, timedOut, stdoutTruncated } = await run(
      this.bin, this.buildArgs(prompt, opts), opts.cwd, opts.timeoutMs ?? 600_000, opts.env, opts.envUnset,
    );
    const durationMs = Date.now() - started;
    const events: unknown[] = [];
    let sessionId: string | undefined;
    let output = '';
    let lastFinish: any;
    let explicitError: string | undefined;
    let input = 0, cacheRead = 0, cacheWrite = 0, outputTokens = 0, reasoning = 0;
    let hasUsage = false;

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { continue; }
      events.push(event);
      if (typeof event.sessionID === 'string') sessionId = event.sessionID;
      if (event.type === 'text' && typeof event.part?.text === 'string' && event.part.text.trim()) output = event.part.text.trim();
      if (event.type === 'error') explicitError = openCodeError(event.error);
      if (event.type === 'step_finish' && event.part?.type === 'step-finish') {
        lastFinish = event.part;
        const tokens = event.part.tokens;
        if (tokens && typeof tokens === 'object') {
          hasUsage = true;
          input += finite(tokens.input);
          cacheRead += finite(tokens.cache?.read);
          cacheWrite += finite(tokens.cache?.write);
          outputTokens += finite(tokens.output);
          reasoning += finite(tokens.reasoning);
        }
      }
    }

    const usage: TokenUsage | undefined = hasUsage ? {
      inputTokens: input + cacheRead + cacheWrite,
      cachedInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      outputTokens: outputTokens + reasoning,
      reasoningOutputTokens: reasoning,
    } : undefined;
    const complete = lastFinish !== undefined;
    const lengthLimited = lastFinish?.reason === 'length';
    const ok = exitCode === 0 && !timedOut && !explicitError && complete
      && lastFinish.reason === 'stop' && output.length > 0 && sessionId !== undefined;
    const error = ok ? undefined
      : timedOut ? `opencode timed out after ${opts.timeoutMs ?? 600_000}ms`
      : explicitError
      ?? (!complete ? `opencode emitted no terminal step_finish event (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`
        : lastFinish.reason !== 'stop' ? `opencode finish reason=${String(lastFinish.reason)} (exit ${exitCode})`
        : !sessionId ? 'opencode result omitted the session id'
        : output.length === 0 ? 'opencode reported success with no assistant output'
        : `opencode failed (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`);
    const result: WorkerResult = {
      ok, output, sessionId, usage, durationMs, exitCode, error, raw: events,
      ...(!complete || timedOut || lengthLimited ? { incomplete: true as const } : {}),
      ...(lengthLimited ? { truncated: true as const } : {}),
    };
    return failIfTruncated(result, stdoutTruncated, 'opencode', stderr);
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function openCodeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return 'opencode error event';
  const row = error as Record<string, any>;
  return String(row.data?.message ?? row.message ?? row.name ?? 'opencode error event');
}
