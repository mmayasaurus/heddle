import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { Ledger } from './ledger.js';
import { resolveIdentity, attributeDispatch } from './identity.js';
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
 * materializes skill packs or attaches MCP.
 *
 * They ARE ledgered, as `execution_mode='classification'` rows (HED-25, Maya-decided 2026-08-17).
 * They previously were not, on the reasoning that a meta-classification should not look like a
 * worker row — correct as far as it went, but the consequence was that every --auto-effort and every
 * auto-assess spent real Codex tokens that `heddle usage`, the Fleet drawer and the savings
 * analytics never saw. Marking the row keeps BOTH properties: the spend is visible, and every
 * worker-facing aggregate excludes it by default.
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
  /** Which classifier this is — recorded as the row's task_class so spend is attributable. */
  kind = 'classification',
  /** Injectable so tests never write to the operator's real ledger. */
  ledger?: Ledger,
): Promise<ClassifyResult> {
  const prompt =
    `${instruction}\n\nReply with EXACTLY ONE of these labels and nothing else: ${labels.join(' | ')}.`;
  const started = Date.now();
  const res = await adapterFor(cfg).dispatch(prompt, {
    model: cfg.model, cwd, extraFlags: cfg.extraFlags, timeoutMs,
  });
  // Best-effort accounting: a ledger failure must never break the classification the caller asked
  // for (and a classifier is advisory anyway — losing the ROW is far cheaper than losing the run).
  try {
    const identity = resolveIdentity();
    const attribution = attributeDispatch(identity, undefined);
    // An injected ledger belongs to the caller and must NOT be closed here; a fallback one is ours
    // to close, or every classification leaks a SQLite handle in a long-lived process (PR #40, gitar).
    const own = ledger ? null : new Ledger();
    (ledger ?? own!).recordClassification({
      orchestrator: attribution.orchestrator, identitySource: attribution.identitySource,
      kind, provider: cfg.provider, model: cfg.model, cwd, promptPreview: instruction,
      ok: res.ok, error: res.error,
      inputTokens: res.usage?.inputTokens, cachedInputTokens: res.usage?.cachedInputTokens,
      outputTokens: res.usage?.outputTokens, reasoningTokens: res.usage?.reasoningOutputTokens,
      durationMs: res.durationMs ?? Date.now() - started,
    });
    if (own) own.close();
  } catch (err) {
    process.stderr.write(`heddle: could not ledger the ${kind} classification (${err instanceof Error ? err.message : String(err)})\n`);
  }
  const out = (res.output || '').toLowerCase();
  // Prefer a whole-word match (hyphen or space tolerant), else any substring occurrence.
  const wordMatch = labels.find((l) =>
    new RegExp(`\\b${l.toLowerCase().replace(/-/g, '[- ]')}\\b`).test(out));
  const anyMatch = wordMatch ?? labels.find((l) => out.includes(l.toLowerCase()));
  return { label: anyMatch ?? labels[0], matched: Boolean(anyMatch), raw: res.output };
}

export const EFFORT_LABELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** PRE-dispatch: pick a reasoning-effort level for a sub-task. */
export async function classifyEffort(taskClass: string, task: string, cwd?: string, ledger?: Ledger): Promise<string> {
  const r = await classify(
    `You are a reasoning-effort classifier for a coding sub-task in the "${taskClass}" class. ` +
    `Judge how much reasoning it needs: minimal (trivial/mechanical, e.g. a rename) up through ` +
    `xhigh (subtle, multi-step, cross-cutting, or high-stakes). Sub-task:\n${task}`,
    [...EFFORT_LABELS], cwd, DEFAULT_CLASSIFIER, 120_000, 'classify-effort', ledger);
  return r.label;
}

export const RESULT_LABELS = ['done', 'needs-rework', 'needs-human'] as const;
export type ResultAssessment = { label: string; matched: boolean };

/** POST-dispatch: judge a worker's result. `needs-human` is the needs-human-queue trigger. */
export async function assessResult(
  task: string, output: string, workerOk: boolean, cwd?: string, ledger?: Ledger,
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
    [...RESULT_LABELS], cwd, ASSESS_CLASSIFIER, 120_000, 'assess-result', ledger);
  return { label: r.label, matched: r.matched };
}
