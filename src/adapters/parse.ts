import type { WorkerResult } from '../types.js';
import { DEFAULT_MAX_STREAM_BYTES } from './subprocess.js';

/**
 * Shared stdout parsing for adapters whose CLI prints one `{type:"result"}` JSON object as the
 * last JSON line (claude `--output-format json`, cursor-agent `--output-format json`). Progress
 * noise may precede it, so scan bottom-up and skip anything that is not the result object.
 */
export function lastResultJson(stdout: string): any | undefined {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.type === 'result') return parsed;
    } catch { /* keep scanning */ }
  }
  return undefined;
}

/**
 * This keys on STDOUT truncation only: stderr truncation does not fail the turn because adapters
 * parse the result from stdout. A truncated stdout stream can still parse into a
 * plausible-but-incomplete result (an earlier NDJSON event, a cut final JSON), so a parsed ok:true
 * is unreliable. Force an explicit turn failure, preserving raw/usage/exitCode for the ledger.
 */
export function failIfTruncated(result: WorkerResult, stdoutTruncated: boolean, cli: string, stderr = ''): WorkerResult {
  if (!stdoutTruncated) return result;
  const note = `${cli} stdout exceeded the ${DEFAULT_MAX_STREAM_BYTES}-byte stream cap and was truncated — result unreliable, treated as a turn failure`;
  const error = result.error
    ? `${note}; ${result.error}`
    : stderr.trim().length ? `${note}; stderr tail: ${stderr.slice(-400)}` : note;
  return { ...result, ok: false, error, incomplete: true, truncated: true };
}
