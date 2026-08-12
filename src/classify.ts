import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import type { WorkerAdapter } from './types.js';

/**
 * Lightweight classification via a cheap CLI dispatch — heddle's "tiny model" role, done with a
 * cheap subscription model instead of a local in-process model (decided 2026-08-04: the
 * classification happens at dispatch boundaries, not per-turn, so frequency is low and a cheap
 * CLI model is both more reliable and zero-setup; a local model can replace this later if a
 * high-frequency chore ever needs free-per-call).
 *
 * NOTE on scope: for black-box CLI workers, per-TURN auditing (omp's model) is harness-locked —
 * heddle can't see inside a running worker. So classification lives at the boundaries:
 *   - classifyEffort  (PRE-dispatch): difficulty → reasoning effort.
 *   - assessResult    (POST-dispatch): a worker's result → done | needs-rework | needs-human.
 *
 * These call an adapter DIRECTLY (not the full dispatch pipeline) so a meta-classification never
 * materializes skill packs, attaches MCP, or records a worker row in the ledger.
 */

export interface ClassifierConfig {
  provider: 'codex' | 'cursor';
  model: string;
  extraFlags?: string[];
}

/** Default: codex's cheapest tier, run lean (skip the ~22k-token global-config auto-load).
 *  Fine for the simple effort rubric. */
export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  provider: 'codex',
  model: 'gpt-5.6-luna',
  // (CodexAdapter runs lean by default now — no need to pass --ignore-user-config here.)
};

/** A step up for the harder judgment call (done vs rework vs human) — luna was too conservative,
 *  flagging credibly-completed work as needs-rework. terra is the balanced tier, still cheap. */
export const ASSESS_CLASSIFIER: ClassifierConfig = {
  provider: 'codex',
  model: 'gpt-5.6-terra',
};

function adapterFor(cfg: ClassifierConfig): WorkerAdapter {
  return cfg.provider === 'cursor' ? new CursorAdapter() : new CodexAdapter('codex', 'read-only');
}

export interface ClassifyResult {
  /** The chosen label (falls back to labels[0] if the model's reply didn't match any). */
  label: string;
  /** True only if the model actually returned a recognizable label. */
  matched: boolean;
  raw: string;
}

export async function classify(
  instruction: string,
  labels: string[],
  cwd: string = process.cwd(),
  cfg: ClassifierConfig = DEFAULT_CLASSIFIER,
  timeoutMs = 120_000,
): Promise<ClassifyResult> {
  const prompt =
    `${instruction}\n\nReply with EXACTLY ONE of these labels and nothing else: ${labels.join(' | ')}.`;
  const res = await adapterFor(cfg).dispatch(prompt, {
    model: cfg.model, cwd, extraFlags: cfg.extraFlags, timeoutMs,
  });
  const out = (res.output || '').toLowerCase();
  // Prefer a whole-word match (hyphen or space tolerant), else any substring occurrence.
  const wordMatch = labels.find((l) =>
    new RegExp(`\\b${l.toLowerCase().replace(/-/g, '[- ]')}\\b`).test(out));
  const anyMatch = wordMatch ?? labels.find((l) => out.includes(l.toLowerCase()));
  return { label: anyMatch ?? labels[0], matched: Boolean(anyMatch), raw: res.output };
}

export const EFFORT_LABELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** PRE-dispatch: pick a reasoning-effort level for a sub-task. */
export async function classifyEffort(taskClass: string, task: string, cwd?: string): Promise<string> {
  const r = await classify(
    `You are a reasoning-effort classifier for a coding sub-task in the "${taskClass}" class. ` +
    `Judge how much reasoning it needs: minimal (trivial/mechanical, e.g. a rename) up through ` +
    `xhigh (subtle, multi-step, cross-cutting, or high-stakes). Sub-task:\n${task}`,
    [...EFFORT_LABELS], cwd);
  return r.label;
}

export const RESULT_LABELS = ['done', 'needs-rework', 'needs-human'] as const;
export type ResultAssessment = { label: string; matched: boolean };

/** POST-dispatch: judge a worker's result. `needs-human` is the needs-human-queue trigger. */
export async function assessResult(
  task: string, output: string, workerOk: boolean, cwd?: string,
): Promise<ResultAssessment> {
  const r = await classify(
    `You are a QA classifier deciding what to do with a worker's result. Classify as EXACTLY one:\n` +
    `- done: the worker credibly completed the sub-task. A self-reported completion that names the ` +
    `specific change(s) it made counts as done UNLESS the result clearly shows a problem.\n` +
    `- needs-rework: the result is clearly wrong, incomplete, or the worker failed — a worker could ` +
    `retry with sharper instructions.\n` +
    `- needs-human: the worker is blocked on a decision, permission, missing information, or ambiguity ` +
    `that ONLY the human operator can resolve (a retry would not fix it).\n` +
    `Default to "done" when the worker reports success with specifics and nothing indicates a problem.\n\n` +
    `Sub-task:\n${task}\n\nWorker reported success=${workerOk}. Worker result:\n${output.slice(0, 4000)}`,
    [...RESULT_LABELS], cwd, ASSESS_CLASSIFIER);
  return { label: r.label, matched: r.matched };
}
