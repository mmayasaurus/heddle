import { spawn } from 'node:child_process';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../types.js';

/**
 * Cursor CLI adapter — `cursor-agent -p --output-format json`.
 *
 * Invocation contract (live-verified 2026-08-01, cursor-agent 2026.07.23 — docs/LANDMINES.md):
 *  - `--trust` required in workspaces the CLI hasn't seen (fresh worktrees) or headless hard-fails.
 *  - Result is ONE JSON object: {type:"result", is_error, result, session_id, request_id,
 *    duration_ms}.
 *  - `-p --resume <session_id>` verified to carry real context continuity.
 *  - Policy (routing/routing.v0.yaml): supplemental models only — never claude/gpt/gemini ids.
 */
export class CursorAdapter implements WorkerAdapter {
  readonly name = 'cursor';
  readonly provider = 'cursor' as const;

  constructor(private readonly bin = 'cursor-agent') {}

  async dispatch(prompt: string, opts: DispatchOptions): Promise<WorkerResult> {
    const args = ['-p', '--output-format', 'json', '--trust', '--model', opts.model];
    if (opts.resume) args.push('--resume', opts.resume);
    args.push(...(opts.extraFlags ?? []), prompt);

    const started = Date.now();
    const { stdout, stderr, exitCode } = await run(this.bin, args, opts.cwd, opts.timeoutMs ?? 600_000);
    const durationMs = Date.now() - started;

    // The result object is the last JSON line on stdout (progress noise may precede it).
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
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `no result JSON from cursor-agent (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
      };
    }

    const ok = exitCode === 0 && result.is_error !== true;
    return {
      ok,
      output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? ''),
      sessionId: result.session_id,
      durationMs: result.duration_ms ?? durationMs,
      exitCode,
      error: ok ? undefined : `cursor-agent is_error=${result.is_error} (exit ${exitCode})`,
      raw: result,
    };
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number):
  Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
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
