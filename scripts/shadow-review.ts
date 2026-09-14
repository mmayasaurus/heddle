#!/usr/bin/env node
/**
 * Manual-only HED-565 shadow reviewer. It replays a reconstructed historical review
 * diff through the local adapter and records an append-only scoring receipt; it does
 * not alter routing, lanes, scheduling, or reviewer activation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  aggregateScoredRounds,
  asJudgeResult,
  buildCandidatePrompt,
  buildCorpus,
  extractJudgeJson,
  judgePrompt,
  type CorpusRound,
  type CorpusSummary,
  type GhRunner,
  type GitRunner,
  type ScoredRound,
} from './bench-adversarial-review.js';

export const DEFAULT_LIMIT = 30;
// HED-321 promotion bar (R's decision, Maya-ratified firsthand 2026-08-22). Promotion needs ALL FOUR:
// (1) >= SHADOW_BAR_MIN_DIFFS shadow diffs scored vs cloud on the SAME diffs; (2) >= SHADOW_BAR_MIN_DAYS
// calendar days elapsed; (3) local precision >= the cloud family's precision on those same diffs
// (RELATIVE, not an absolute %); (4) ZERO hallucinated-citation findings surviving the mechanical
// file:line post-check. Recall is explicitly NOT a promotion gate. Activation stays Maya-gated regardless.
export const SHADOW_BAR_MIN_DIFFS = 20;
export const SHADOW_BAR_MIN_DAYS = 5;
export const DEFAULT_LOCAL_MODEL = 'local';
export const JUDGE_MODEL = 'gpt-5.6-sol';
const CANDIDATE_REASON = "HED-565 shadow-mode: measure the local reviewer's inline-diff-only adversarial-review recall/precision versus the seated pool on a real reviewed diff; receipts gate activation";
const JUDGE_REASON = "HED-565 shadow-mode: judge scores the local candidate's findings against the incumbent's accepted findings";

export interface DispatchRunnerRequest {
  provider: string;
  model: string;
  prompt: string;
  overrideReason: string;
  issue: string;
  cwd: string;
  timeoutMs: number;
}

export interface DispatchRunnerResult {
  ok: boolean;
  output?: string;
  error?: string;
  ledgerId?: number;
  raw?: unknown;
}

export type DispatchRunner = (request: DispatchRunnerRequest) => DispatchRunnerResult;
export type BuildCorpus = (out: string, opts: { limit?: number; pairs?: string[] }, gh?: GhRunner, git?: GitRunner, ledgerPath?: string) => CorpusSummary;

export interface ShadowOptions {
  dispatchId?: number;
  dryRun?: boolean;
  json?: boolean;
  limit?: number;
}

export interface ScoredReceipt {
  dispatchId: number;
  issue: string;
  pr: number;
  repo: CorpusRound['repo'];
  authorProvider: string | null;
  reviewerProvider: string;
  reviewerModel: string;
  candidateProvider: 'local';
  candidateModel: string;
  /** Ledger ids of the candidate/judge dispatches — the resolved model + full I/O live on those rows. */
  candidateLedgerId?: number;
  judgeLedgerId?: number;
  findingsTotal: number;
  findingsAccepted: number;
  tp: number;
  fp: number;
  novel: number;
  /** Local findings whose cited file:line is NOT present in the diff (the gate-4 mechanical post-check).
   *  Optional until that post-check lands (separate follow-up); the promotion gate requires it to be 0. */
  hallucinatedCitations?: number;
  acceptedMatched: number;
  recall: number | null;
  precision: number | null;
  status: 'scored';
  at: string;
}

export interface SkippedReceipt {
  dispatchId?: number;
  status: 'skipped';
  reason: string;
  at: string;
}

export type ShadowReceipt = ScoredReceipt | SkippedReceipt;

export type ShadowResult =
  | { status: 'scored'; dispatchId: number; tp: number; fp: number; novel: number; acceptedMatched: number; recall: number | null; precision: number | null; receipt: ScoredReceipt }
  | { status: 'skipped'; dispatchId?: number; reason: string };

export interface ShadowDeps {
  buildCorpus?: BuildCorpus;
  dispatchRunner?: DispatchRunner;
  gh?: GhRunner;
  git?: GitRunner;
  ledgerPath?: string;
  receiptDir?: string;
  workDir?: string;
  now?: () => Date;
}

function defaultReceiptDir(): string {
  return process.env.HEDDLE_SHADOW_DIR || join(homedir(), '.heddle', 'shadow-review');
}

function defaultLedgerPath(): string {
  return process.env.HEDDLE_LEDGER || join(homedir(), '.heddle', 'ledger.db');
}

function shadowDirs(deps: ShadowDeps): { receiptDir: string; workDir: string } {
  const receiptDir = deps.receiptDir ?? defaultReceiptDir();
  return { receiptDir, workDir: deps.workDir ?? join(receiptDir, 'work') };
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${path} line ${index + 1} is not valid JSON`); }
  });
}

export function readShadowReceipts(receiptDir: string): ShadowReceipt[] {
  return readJsonLines<ShadowReceipt>(join(receiptDir, 'receipts.jsonl'));
}

function appendReceipt(receiptDir: string, receipt: ShadowReceipt): void {
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, 'receipts.jsonl'), `${JSON.stringify(receipt)}\n`, { flag: 'a' });
}

function errorText(result: DispatchRunnerResult): string {
  return result.error?.trim() || 'dispatch returned ok:false without an error';
}

function actualLocalModel(result: DispatchRunnerResult, requested: string): string {
  if (result.raw && typeof result.raw === 'object' && !Array.isArray(result.raw)) {
    const model = (result.raw as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim()) return model;
  }
  return requested;
}

function candidatePrompt(candDir: string, round: CorpusRound): string {
  // The benchmark's behavior-preserving API returns its generated prompt path. Re-read that exact
  // artifact instead of rebuilding the prompt here, preserving a single prompt definition.
  return readFileSync(buildCandidatePrompt(candDir, round), 'utf8');
}

function scoredRound(round: CorpusRound, judgeOutput: string): ScoredRound {
  const judge = asJudgeResult(extractJudgeJson(judgeOutput), round);
  return {
    ...round,
    tp: judge.candidateFindings.filter((finding) => finding.class === 'TP').length,
    fp: judge.candidateFindings.filter((finding) => finding.class === 'FP').length,
    novel: judge.candidateFindings.filter((finding) => finding.class === 'NOVEL').map(({ idx, rationale }) => ({ idx, rationale })),
    acceptedMatched: judge.acceptedIncumbentMatchedCount,
  };
}

function skipResult(dispatchId: number | undefined, reason: string, receiptDir: string, at: string, dryRun: boolean, write = true): ShadowResult {
  if (write && !dryRun) appendReceipt(receiptDir, { ...(dispatchId === undefined ? {} : { dispatchId }), status: 'skipped', reason, at });
  return { status: 'skipped', ...(dispatchId === undefined ? {} : { dispatchId }), reason };
}

/** Runs one manual shadow round. No scheduler, routing table, lane, or launchd path is consulted. */
export function runShadowRound(options: ShadowOptions = {}, deps: ShadowDeps = {}): ShadowResult {
  const { receiptDir, workDir } = shadowDirs(deps);
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const corpusDir = join(workDir, 'corpus');
  const corpusBuilder = deps.buildCorpus ?? buildCorpus;
  const dispatchRunner = deps.dispatchRunner ?? defaultDispatchRunner;
  let summary: CorpusSummary;
  let rounds: CorpusRound[];
  try {
    summary = corpusBuilder(corpusDir, { limit: options.limit ?? DEFAULT_LIMIT }, deps.gh, deps.git, deps.ledgerPath ?? defaultLedgerPath());
    rounds = readJsonLines<CorpusRound>(join(corpusDir, 'corpus.jsonl'));
  } catch (error) {
    return skipResult(undefined, `corpus-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, Boolean(options.dryRun));
  }

  const scoredIds = new Set(
    readShadowReceipts(receiptDir)
      .filter((receipt): receipt is ScoredReceipt => receipt.status === 'scored')
      .map((receipt) => receipt.dispatchId),
  );
  const selected = options.dispatchId === undefined
    ? rounds.find((round) => !scoredIds.has(round.dispatchId))
    : rounds.find((round) => round.dispatchId === options.dispatchId);
  if (!selected) {
    return options.dispatchId === undefined
      ? skipResult(undefined, 'no-qualifying-round', receiptDir, at, Boolean(options.dryRun), false)
      : skipResult(options.dispatchId, 'no-such-round', receiptDir, at, Boolean(options.dryRun));
  }

  const requestedModel = process.env.HEDDLE_SHADOW_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
  let candidate: DispatchRunnerResult;
  try {
    candidate = dispatchRunner({ provider: 'local', model: requestedModel, prompt: candidatePrompt(join(workDir, 'cand'), selected), overrideReason: CANDIDATE_REASON, issue: 'HED-565', cwd: workDir, timeoutMs: 600_000 });
  } catch (error) {
    return skipResult(selected.dispatchId, `local-declined:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, Boolean(options.dryRun));
  }
  if (!candidate.ok) return skipResult(selected.dispatchId, `local-declined:${errorText(candidate)}`, receiptDir, at, Boolean(options.dryRun));

  let judge: DispatchRunnerResult;
  try {
    judge = dispatchRunner({ provider: 'codex', model: JUDGE_MODEL, prompt: judgePrompt(selected, candidate.output ?? ''), overrideReason: JUDGE_REASON, issue: 'HED-565', cwd: workDir, timeoutMs: 600_000 });
  } catch (error) {
    return skipResult(selected.dispatchId, `judge-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, Boolean(options.dryRun));
  }
  if (!judge.ok) return skipResult(selected.dispatchId, `judge-failed:${errorText(judge)}`, receiptDir, at, Boolean(options.dryRun));

  try {
    const round = scoredRound(selected, judge.output ?? '');
    const report = aggregateScoredRounds('local', [round], summary);
    const receipt: ScoredReceipt = {
      dispatchId: selected.dispatchId, issue: selected.issue, pr: selected.pr, repo: selected.repo,
      authorProvider: selected.authorProvider, reviewerProvider: selected.reviewerProvider, reviewerModel: selected.reviewerModel,
      candidateProvider: 'local', candidateModel: actualLocalModel(candidate, requestedModel),
      candidateLedgerId: candidate.ledgerId, judgeLedgerId: judge.ledgerId,
      findingsTotal: selected.findingsTotal, findingsAccepted: selected.findingsAccepted,
      tp: round.tp, fp: round.fp, novel: round.novel.length, acceptedMatched: round.acceptedMatched,
      recall: report.totals.recall, precision: report.totals.precision, status: 'scored', at,
    };
    if (!options.dryRun) appendReceipt(receiptDir, receipt);
    return { status: 'scored', dispatchId: selected.dispatchId, tp: round.tp, fp: round.fp, novel: round.novel.length, acceptedMatched: round.acceptedMatched, recall: report.totals.recall, precision: report.totals.precision, receipt };
  } catch (error) {
    return skipResult(selected.dispatchId, `score-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, Boolean(options.dryRun));
  }
}

function pct(value: number | null): string { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

// "calendar days elapsed" (gate 2) is read as the SPAN from the earliest to the latest scored receipt
// (e.g. 09-14 -> 09-19 = 5.0 days), not a count of distinct dates.
function spanDays(scored: readonly ScoredReceipt[]): number {
  const times = scored.map((receipt) => Date.parse(receipt.at)).filter((time) => Number.isFinite(time));
  return times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / 86_400_000;
}

/**
 * Renders receipt history and progress toward the HED-321 promotion bar (the four gates in the constants
 * above). It only REPORTS — it never makes or applies an activation decision; activation stays Maya-gated.
 * Recall is shown for information only and is deliberately not a gate.
 */
export function renderShadowReport(receipts: readonly ShadowReceipt[]): string {
  const scored = receipts.filter((receipt): receipt is ScoredReceipt => receipt.status === 'scored');
  const totals = scored.reduce((result, receipt) => ({
    tp: result.tp + receipt.tp, fp: result.fp + receipt.fp, novel: result.novel + receipt.novel,
    acceptedMatched: result.acceptedMatched + receipt.acceptedMatched,
    findingsAccepted: result.findingsAccepted + receipt.findingsAccepted,
    findingsTotal: result.findingsTotal + receipt.findingsTotal,
    hallucinated: result.hallucinated + (receipt.hallucinatedCitations ?? 0),
  }), { tp: 0, fp: 0, novel: 0, acceptedMatched: 0, findingsAccepted: 0, findingsTotal: 0, hallucinated: 0 });
  // Gate precision is RELATIVE and confirmed-real/raised for BOTH families on the same diffs:
  //   cloud  = findingsAccepted / findingsTotal (what the incumbent confirmed over what it raised).
  //   local  = tp / (tp + fp + novel): only TP is confirmed against ground truth; NOVEL is raised but
  //   UNCONFIRMED (some NOVEL may be genuinely real — final NOVEL handling is R's call at promotion), so
  //   it belongs in the denominator. This is a conservative lower bound and IS the gate-comparable figure.
  const raised = totals.tp + totals.fp + totals.novel;
  const localPrecision = raised === 0 ? null : totals.tp / raised;
  const localPrecisionExclNovel = totals.tp + totals.fp === 0 ? null : totals.tp / (totals.tp + totals.fp);
  const cloudPrecision = totals.findingsTotal === 0 ? null : totals.findingsAccepted / totals.findingsTotal;
  const recall = totals.findingsAccepted === 0 ? null : totals.acceptedMatched / totals.findingsAccepted;
  const days = spanDays(scored);
  const hallucinationKnown = scored.some((receipt) => receipt.hallucinatedCitations !== undefined);
  const precisionMeets = localPrecision !== null && cloudPrecision !== null && localPrecision >= cloudPrecision;
  const tick = (met: boolean): string => (met ? ' ✓' : ' …');

  const lines = [`${scored.length} rounds scored, ${totals.novel} novel, recall ${pct(recall)} (informational — NOT a promotion gate)`];
  lines.push('Promotion bar (HED-321 — all four must hold; activation stays Maya-gated):');
  lines.push(`  • diffs: ${scored.length}/${SHADOW_BAR_MIN_DIFFS}${tick(scored.length >= SHADOW_BAR_MIN_DIFFS)}`);
  lines.push(`  • calendar days elapsed: ${days.toFixed(1)}/${SHADOW_BAR_MIN_DAYS}${tick(days >= SHADOW_BAR_MIN_DAYS)}`);
  lines.push(`  • precision (confirmed-real/raised, same diffs — the gate): local ${pct(localPrecision)} vs cloud ${pct(cloudPrecision)}${tick(precisionMeets)}`);
  lines.push(`      context: local excl. NOVEL = ${pct(localPrecisionExclNovel)} (NOVEL counted as raised-but-unconfirmed; final NOVEL handling is R's call at promotion)`);
  lines.push(`  • hallucinated citations surviving file:line check: ${hallucinationKnown ? `${totals.hallucinated}${tick(totals.hallucinated === 0)}` : 'pending — mechanical post-check not yet implemented'}`);

  const pairs = new Map<string, ScoredReceipt[]>();
  for (const receipt of scored) {
    const key = `${receipt.reviewerProvider}/${receipt.reviewerModel}`;
    pairs.set(key, [...(pairs.get(key) ?? []), receipt]);
  }
  if (pairs.size) {
    lines.push("Per incumbent reviewer pair (local vs that pair's cloud precision):");
    for (const [pair, items] of [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const t = items.reduce((result, receipt) => ({ tp: result.tp + receipt.tp, fp: result.fp + receipt.fp, novel: result.novel + receipt.novel, findingsAccepted: result.findingsAccepted + receipt.findingsAccepted, findingsTotal: result.findingsTotal + receipt.findingsTotal }), { tp: 0, fp: 0, novel: 0, findingsAccepted: 0, findingsTotal: 0 });
      const pairRaised = t.tp + t.fp + t.novel;
      lines.push(`  ${pair}: ${items.length} rounds, local ${pct(pairRaised === 0 ? null : t.tp / pairRaised)} vs cloud ${pct(t.findingsTotal === 0 ? null : t.findingsAccepted / t.findingsTotal)}`);
    }
  }
  const skips = new Map<string, number>();
  for (const receipt of receipts) if (receipt.status === 'skipped') skips.set(receipt.reason, (skips.get(receipt.reason) ?? 0) + 1);
  if (skips.size) lines.push(`Skipped: ${[...skips.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} (${count})`).join('; ')}`);
  return lines.join('\n');
}

function defaultDispatchRunner(request: DispatchRunnerRequest): DispatchRunnerResult {
  const cli = resolve(dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
  // Attribute to the running fleet identity (so a Maya-run dispatch is not stamped 'W'); default 'W'.
  const agent = process.env.HEDDLE_AGENT ?? process.env.FLEET_AGENT ?? 'W';
  const args = [cli, 'dispatch', '--provider', request.provider, '--model', request.model, '--agent', agent, '--override-reason', request.overrideReason, '--issue', request.issue, '--cwd', request.cwd, '--timeout', String(request.timeoutMs), '--json'];
  // Prompt on stdin (the CLI reads stdin when --task is absent), passed via `input` — no shell, no temp file.
  const child = spawnSync('node', args, { input: request.prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (child.error) return { ok: false, output: '', error: child.error.message };
  try {
    const parsed = JSON.parse(child.stdout ?? '') as { ok?: unknown; output?: unknown; error?: unknown; ledgerId?: unknown };
    const ledgerId = typeof parsed.ledgerId === 'number' ? parsed.ledgerId : undefined;
    let output = typeof parsed.output === 'string' ? parsed.output : '';
    if (!output && ledgerId !== undefined) {
      const outputPath = join(homedir(), '.heddle', 'outputs', `${ledgerId}.md`);
      if (existsSync(outputPath)) output = readFileSync(outputPath, 'utf8');
    }
    return { ok: parsed.ok === true, output, error: typeof parsed.error === 'string' ? parsed.error : undefined, ledgerId };
  } catch (error) {
    return { ok: false, output: '', error: `unparseable dispatch output: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseCli(args: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = args;
  if (!command) throw new Error('usage: shadow-review <run|report> [options]');
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    if (flag === '--dry-run' || flag === '--json') { flags.set(flag, 'true'); continue; }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    flags.set(flag, value);
    index += 1;
  }
  return { command, flags };
}

function ensureOnly(flags: Map<string, string>, allowed: string[]): void {
  for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`unsupported option: ${flag}`);
}

/** Thin synchronous CLI wrapper so all selection and scoring remains testable without dispatches. */
export function runCli(args: string[]): string {
  const { command, flags } = parseCli(args);
  if (command === 'run') {
    ensureOnly(flags, ['--dispatch-id', '--dry-run', '--json']);
    const rawDispatchId = flags.get('--dispatch-id');
    const dispatchId = rawDispatchId === undefined ? undefined : Number(rawDispatchId);
    if (dispatchId !== undefined && (!Number.isInteger(dispatchId) || dispatchId <= 0)) throw new Error('--dispatch-id must be a positive integer');
    const result = runShadowRound({ dispatchId, dryRun: flags.has('--dry-run') });
    return flags.has('--json') ? JSON.stringify(result) : result.status === 'scored'
      ? `scored ${result.dispatchId}: tp=${result.tp} fp=${result.fp} novel=${result.novel} recall=${pct(result.recall)} precision=${pct(result.precision)}`
      : `skipped${result.dispatchId === undefined ? '' : ` ${result.dispatchId}`}: ${result.reason}`;
  }
  if (command === 'report') {
    ensureOnly(flags, ['--json']);
    const receiptDir = defaultReceiptDir();
    const report = renderShadowReport(readShadowReceipts(receiptDir));
    return flags.has('--json') ? JSON.stringify({ report }) : report;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.stdout.write(`${runCli(process.argv.slice(2))}\n`); } catch (error) {
    process.stderr.write(`shadow-review: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
