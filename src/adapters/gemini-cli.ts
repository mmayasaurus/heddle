import type { DispatchOptions, TokenUsage, WorkerAdapter, WorkerResult } from '../types.js';
import { failIfTruncated } from './parse.js';
import { run } from './subprocess.js';

/** Native Google Gemini CLI adapter (`gemini --output-format stream-json`). */
export class GeminiCliAdapter implements WorkerAdapter {
  readonly name = 'gemini-cli';
  readonly provider = 'gemini-cli' as const;

  constructor(private readonly bin = 'gemini') {}

  buildArgs(prompt: string, opts: DispatchOptions): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--approval-mode', opts.readOnly ? 'plan' : 'yolo',
      '--model', opts.model,
    ];
    if (opts.resume) args.push('--resume', opts.resume);
    for (const server of opts.mcpServers ?? []) args.push('--allowed-mcp-server-names', server);
    args.push(...(opts.extraFlags ?? []), '--prompt', prompt);
    return args;
  }

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const started = Date.now();
    const { stdout, stderr, exitCode, timedOut, stdoutTruncated } = await run(
      this.bin, this.buildArgs(prompt, opts), opts.cwd, opts.timeoutMs ?? 600_000, opts.env, opts.envUnset,
    );
    const elapsed = Date.now() - started;
    const events: unknown[] = [];
    let sessionId: string | undefined;
    let reportedModel: string | undefined;
    let output = '';
    let terminal: any;
    let fatalEvent: string | undefined;

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let event: any;
      try { event = JSON.parse(trimmed); } catch { continue; }
      events.push(event);
      if (event.type === 'init') {
        if (typeof event.session_id === 'string') sessionId = event.session_id;
        if (typeof event.model === 'string') reportedModel = event.model;
      }
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
        output = event.delta === true ? output + event.content : event.content;
      }
      if (event.type === 'error' && event.severity === 'error') fatalEvent = String(event.message ?? 'Gemini CLI error event');
      if (event.type === 'result') terminal = event;
    }

    const stats = terminal?.stats;
    const usage: TokenUsage | undefined = stats && typeof stats === 'object'
      ? {
          inputTokens: numberOrUndefined(stats.input_tokens),
          cachedInputTokens: numberOrUndefined(stats.cached),
          outputTokens: numberOrUndefined(stats.output_tokens),
        }
      : undefined;
    const modelMismatch = reportedModel !== undefined && reportedModel !== opts.model;
    const complete = terminal !== undefined;
    const cleanOutput = output.trim();
    const ok = exitCode === 0 && !timedOut && complete && terminal.status === 'success'
      && !fatalEvent && !modelMismatch && cleanOutput.length > 0 && sessionId !== undefined;
    const error = ok ? undefined
      : timedOut ? `gemini CLI timed out after ${opts.timeoutMs ?? 600_000}ms`
      : !complete ? `gemini CLI emitted no terminal result event (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`
      : terminal.status !== 'success' ? String(terminal.error?.message ?? `gemini CLI status=${terminal.status} (exit ${exitCode})`)
      : fatalEvent ?? (modelMismatch
        ? `model fallback detected: requested "${opts.model}" but gemini CLI ran "${reportedModel}"`
        : !sessionId ? 'gemini CLI result omitted the session id'
        : cleanOutput.length === 0 ? 'gemini CLI reported success with no assistant output'
        : `gemini CLI failed (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`);
    const result: WorkerResult = {
      ok, output: cleanOutput, sessionId, usage,
      durationMs: numberOrUndefined(stats?.duration_ms) ?? elapsed,
      exitCode, error, raw: events,
      ...(!complete || timedOut ? { incomplete: true as const } : {}),
    };
    return failIfTruncated(result, stdoutTruncated, 'gemini', stderr);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
