import { spawn } from 'node:child_process';
import { buildWorkerEnv } from '../env.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult, TokenUsage } from '../types.js';
import { lastResultJson } from './parse.js';

/**
 * Model families Cursor carries that Maya holds a DIRECT subscription for. Routing these through
 * Cursor would spend the wrong pool (policy: routing/routing.v0.yaml `never_via_cursor`).
 * Enforced here so a bad routing-table entry can't silently misbill.
 */
const DIRECT_SUBSCRIPTION_PREFIXES = ['claude-', 'gpt-', 'gemini-', 'o1-', 'o3-'];

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
    if (DIRECT_SUBSCRIPTION_PREFIXES.some((p) => opts.model.startsWith(p))) {
      return {
        ok: false, output: '', exitCode: null,
        error: `policy: "${opts.model}" belongs to a family with a direct subscription — ` +
          `route it to that provider's adapter, not through Cursor`,
      };
    }

    const args = ['-p', '--output-format', 'json', '--trust', '--model', opts.model];
    if (opts.resume) args.push('--resume', opts.resume);
    args.push(...(opts.extraFlags ?? []), prompt);

    const started = Date.now();
    const { stdout, stderr, exitCode } =
      await run(this.bin, args, opts.cwd, opts.timeoutMs ?? 600_000, opts.env);
    const durationMs = Date.now() - started;

    // The result object is the last JSON line on stdout (progress noise may precede it).
    const result: any = lastResultJson(stdout);

    if (!result) {
      return {
        ok: false, output: '', exitCode, durationMs,
        error: `no result JSON from cursor-agent (exit ${exitCode}); stderr tail: ${stderr.slice(-400)}`,
      };
    }

    // usage block confirmed live 2026-08-01 (undocumented at research time):
    // {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
    const u = result.usage ?? {};
    const usage: TokenUsage | undefined = Object.keys(u).length
      ? {
          inputTokens: u.inputTokens,
          cachedInputTokens: u.cacheReadTokens,
          outputTokens: u.outputTokens,
        }
      : undefined;

    const ok = exitCode === 0 && result.is_error !== true;
    return {
      ok,
      output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? ''),
      sessionId: result.session_id,
      usage,
      durationMs: result.duration_ms ?? durationMs,
      exitCode,
      error: ok ? undefined : `cursor-agent is_error=${result.is_error} (exit ${exitCode})`,
      raw: result,
    };
  }
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number,
             envOverrides?: Record<string, string>):
  Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
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
