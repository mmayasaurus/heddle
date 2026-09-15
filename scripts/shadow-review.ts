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

interface RoundContext {
  dispatchRunner: DispatchRunner;
  workDir: string;
  receiptDir: string;
  summary: CorpusSummary;
  at: string;
  dryRun: boolean;
}

type CitationRanges = Map<string, Array<[number, number]>>;
interface DiffSides {
  oldSide: CitationRanges;
  newSide: CitationRanges;
}
interface ParsedCitation {
  path: string;
  lo: number;
  hi: number;
  key: string;
}

/** basename of a POSIX-ish path (segment after the last `/`). */
function citationBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Normalise a unified-diff path token: text before any tab, `a/`/`b/` prefix dropped, `/dev/null` → null. */
function diffPath(raw: string): string | null {
  const p = (raw.split('\t')[0] ?? '').trim();
  if (p === '' || p === '/dev/null') return null;
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

interface HunkBody {
  oldRem: number;
  newRem: number;
  inBody: boolean;
}

/** Append a half-open range to a path's range list. */
function pushRange(map: CitationRanges, path: string, range: [number, number]): void {
  const list = map.get(path);
  if (list) list.push(range);
  else map.set(path, [range]);
}

/** Advance hunk-body counters for one line. Returns true when the line was consumed as a body line; false when
 *  it is not a body line — a short/malformed hunk has ended and the caller must reprocess it as a header. A
 *  body line whose text merely begins with `+`/`-`/` ` (e.g. `+++ counter;`) is content, never a header. */
function advanceHunkBody(line: string, body: HunkBody): boolean {
  const c = line.charAt(0);
  if (c === '+') body.newRem -= 1;
  else if (c === '-') body.oldRem -= 1;
  else if (c === ' ') { body.oldRem -= 1; body.newRem -= 1; }
  else if (c === '\\') { /* "\ No newline at end of file" — counts to neither side */ }
  else { body.inBody = false; return false; }
  if (body.oldRem <= 0 && body.newRem <= 0) body.inBody = false;
  return true;
}

/** Record a hunk header's OLD/NEW declared ranges and return the body counters left to consume. Ranges come
 *  from the header counts, so a body shorter/longer than declared (synthetic diffs) still records correctly. */
function recordHunkRanges(hunk: RegExpExecArray, oldPath: string | null, newPath: string | null, sides: DiffSides): HunkBody {
  const os = Number(hunk[1]);
  const oc = hunk[2] === undefined ? 1 : Number(hunk[2]); // `-os` with no comma ⇒ oc=1
  const ns = Number(hunk[3]);
  const nc = hunk[4] === undefined ? 1 : Number(hunk[4]); // `+ns` with no comma ⇒ nc=1
  if (oldPath && Number.isFinite(os) && Number.isFinite(oc) && oc > 0) pushRange(sides.oldSide, oldPath, [os, os + oc]);
  if (newPath && Number.isFinite(ns) && Number.isFinite(nc) && nc > 0) pushRange(sides.newSide, newPath, [ns, ns + nc]);
  const oldRem = Number.isFinite(oc) ? oc : 0;
  const newRem = Number.isFinite(nc) ? nc : 0;
  return { oldRem, newRem, inBody: oldRem > 0 || newRem > 0 };
}

/**
 * Parse a unified diff into per-file OLD-side and NEW-side half-open line ranges (`[start, start+count)`).
 * A STATEFUL hunk-body scanner (`advanceHunkBody`) consumes each hunk's declared line counts, so hunk-body
 * content whose text merely begins with `+++ `, `--- `, or `@@` is treated as an added/deleted/context line,
 * never as a file header (fixes the "`+++ counter;` read as a header" class of bug).
 */
function parseDiffSides(diff: string): DiffSides {
  const sides: DiffSides = { oldSide: new Map(), newSide: new Map() };
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const body: HunkBody = { oldRem: 0, newRem: 0, inBody: false };
  let oldPath: string | null = null;
  let newPath: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (body.inBody && advanceHunkBody(line, body)) continue;
    if (line.startsWith('diff --git ')) { oldPath = null; newPath = null; continue; }
    if (line.startsWith('--- ')) { oldPath = diffPath(line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { newPath = diffPath(line.slice(4)); continue; }
    const hunk = hunkRe.exec(line);
    if (hunk) Object.assign(body, recordHunkRanges(hunk, oldPath, newPath, sides));
  }
  return sides;
}

/**
 * Extract candidate `path:line[-line]` citation tokens. The path token is broad (so extensionless, quoted, and
 * backticked paths are seen — surrounding quotes/backticks/brackets are outside the character class) but must
 * contain a letter, which drops ratios and timestamps like `3:1` or `10:30`. Path-likeness is judged later,
 * against the diff, in `isPathLikeCitation`.
 */
function extractCitations(output: string): ParsedCitation[] {
  const citations: ParsedCitation[] = [];
  // Stop the path token only at whitespace / `:` / `,` / `;` — a deliberately simple class with no brackets,
  // braces, quotes or backticks, which a line-counting linter can misparse (reading the rest of the file as this
  // function's body). Wrapping punctuation is trimmed off the match below instead of excluded in the pattern.
  const citationRe = /([^\s:,;]+):(\d+)(?:\s*-\s*(\d+))?/g;
  const wrap = '()[]{}"\'\x60';
  for (const match of output.matchAll(citationRe)) {
    let path = match[1] ?? '';
    while (path && wrap.includes(path.charAt(0))) path = path.slice(1);
    while (path && wrap.includes(path.charAt(path.length - 1))) path = path.slice(0, -1);
    if (!/[A-Za-z]/.test(path)) continue;
    const start = Number(match[2]);
    if (!Number.isFinite(start)) continue;
    const rawEnd = match[3] === undefined ? start : Number(match[3]);
    const end = Number.isFinite(rawEnd) ? rawEnd : start;
    citations.push({ path, lo: Math.min(start, end), hi: Math.max(start, end), key: `${path}:${start}` });
  }
  return citations;
}

/**
 * A citation is EXAMINED only when its path is "path-like": it has a directory separator or a dotted extension,
 * or its basename actually appears in the diff. This keeps prose tokens (e.g. `timeout:5`) out of a
 * ZERO-tolerance gate — a single spurious count would permanently block promotion — while still examining a
 * fabricated but realistic path (e.g. `src/nope.ts:99`). Residual: an extensionless path NOT present in the
 * diff (e.g. a fabricated `Dockerfile:10` when the diff has no Dockerfile) is indistinguishable from prose and
 * is therefore not counted — the conservative choice for this gate.
 */
function isPathLikeCitation(path: string, sides: DiffSides): boolean {
  if (path.includes('/') || /\.[A-Za-z]/.test(path)) return true;
  const base = citationBasename(path);
  for (const map of [sides.newSide, sides.oldSide]) for (const p of map.keys()) if (citationBasename(p) === base) return true;
  return false;
}

/**
 * Resolve a citation against the diff: true when its inclusive `[lo, hi]` overlaps a half-open range on EITHER
 * side (a reviewer sees the whole diff and may cite a deleted old-side line) of a path that matches
 * exactly / by trailing path-suffix / by basename.
 */
function citationResolves(cit: ParsedCitation, sides: DiffSides): boolean {
  const base = citationBasename(cit.path);
  for (const map of [sides.newSide, sides.oldSide]) {
    for (const [filePath, ranges] of map) {
      if (filePath !== cit.path && !filePath.endsWith(`/${cit.path}`) && citationBasename(filePath) !== base) continue;
      // Inclusive citation [lo, hi] overlaps a half-open range [rs, re) iff lo < re && hi >= rs.
      if (ranges.some(([rs, re]) => cit.lo < re && cit.hi >= rs)) return true;
    }
  }
  return false;
}

/**
 * Gate-4 mechanical post-check (HED-568): count local-reviewer findings whose cited `file:line` is NOT present
 * in the reviewed diff — a "hallucinated citation". Deterministic and best-effort: it NEVER throws on malformed
 * input; a citation (or diff fragment) that fails to parse is skipped, never aborting the count. Distinct
 * hallucinations are deduped by `path:startLine`. See `parseDiffSides` (both-sides, header-safe parsing),
 * `isPathLikeCitation` (precision) and `citationResolves` (lenient path + range overlap) for the semantics.
 */
export function countHallucinatedCitations(candidateOutput: string, diff: string): number {
  const hallucinated = new Set<string>();
  try {
    if (!candidateOutput) return 0;
    const sides = parseDiffSides(diff ?? '');
    for (const cit of extractCitations(candidateOutput)) {
      try {
        if (!isPathLikeCitation(cit.path, sides)) continue;
        if (!citationResolves(cit, sides)) hallucinated.add(cit.key);
      } catch {
        // A single unresolvable citation is skipped — best-effort, never aborts the whole count.
      }
    }
  } catch {
    // Defensive: any unexpected failure yields the best-effort count so far (never throws).
  }
  return hallucinated.size;
}

/** Dispatch the local candidate, then the judge, then score + write the receipt for one selected round.
 *  A local/judge decline or a scoring error is recorded as a skip result — never thrown. */
function dispatchScoreReceipt(selected: CorpusRound, ctx: RoundContext): ShadowResult {
  const { dispatchRunner, workDir, receiptDir, summary, at, dryRun } = ctx;
  const requestedModel = process.env.HEDDLE_SHADOW_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
  let candidate: DispatchRunnerResult;
  try {
    candidate = dispatchRunner({ provider: 'local', model: requestedModel, prompt: candidatePrompt(join(workDir, 'cand'), selected), overrideReason: CANDIDATE_REASON, issue: 'HED-565', cwd: workDir, timeoutMs: 600_000 });
  } catch (error) {
    return skipResult(selected.dispatchId, `local-declined:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, dryRun);
  }
  if (!candidate.ok) return skipResult(selected.dispatchId, `local-declined:${errorText(candidate)}`, receiptDir, at, dryRun);

  let judge: DispatchRunnerResult;
  try {
    judge = dispatchRunner({ provider: 'codex', model: JUDGE_MODEL, prompt: judgePrompt(selected, candidate.output ?? ''), overrideReason: JUDGE_REASON, issue: 'HED-565', cwd: workDir, timeoutMs: 600_000 });
  } catch (error) {
    return skipResult(selected.dispatchId, `judge-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, dryRun);
  }
  if (!judge.ok) return skipResult(selected.dispatchId, `judge-failed:${errorText(judge)}`, receiptDir, at, dryRun);

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
      hallucinatedCitations: countHallucinatedCitations(candidate.output ?? '', selected.diff),
      recall: report.totals.recall, precision: report.totals.precision, status: 'scored', at,
    };
    if (!dryRun) appendReceipt(receiptDir, receipt);
    return { status: 'scored', dispatchId: selected.dispatchId, tp: round.tp, fp: round.fp, novel: round.novel.length, acceptedMatched: round.acceptedMatched, recall: report.totals.recall, precision: report.totals.precision, receipt };
  } catch (error) {
    return skipResult(selected.dispatchId, `score-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, dryRun);
  }
}

/** Runs one manual shadow round. No scheduler, routing table, lane, or launchd path is consulted. */
export function runShadowRound(options: ShadowOptions = {}, deps: ShadowDeps = {}): ShadowResult {
  const { receiptDir, workDir } = shadowDirs(deps);
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const dryRun = Boolean(options.dryRun);
  const corpusDir = join(workDir, 'corpus');
  const corpusBuilder = deps.buildCorpus ?? buildCorpus;
  const dispatchRunner = deps.dispatchRunner ?? defaultDispatchRunner;
  let summary: CorpusSummary;
  let rounds: CorpusRound[];
  try {
    summary = corpusBuilder(corpusDir, { limit: options.limit ?? DEFAULT_LIMIT }, deps.gh, deps.git, deps.ledgerPath ?? defaultLedgerPath());
    rounds = readJsonLines<CorpusRound>(join(corpusDir, 'corpus.jsonl'));
  } catch (error) {
    return skipResult(undefined, `corpus-failed:${error instanceof Error ? error.message : String(error)}`, receiptDir, at, dryRun);
  }

  const scoredIds = new Set(
    readShadowReceipts(receiptDir)
      .filter((receipt): receipt is ScoredReceipt => receipt.status === 'scored')
      .map((receipt) => receipt.dispatchId),
  );
  const selected = options.dispatchId === undefined
    ? rounds.find((round) => !scoredIds.has(round.dispatchId))
    : rounds.find((round) => round.dispatchId === options.dispatchId && !scoredIds.has(round.dispatchId));
  if (!selected) {
    if (options.dispatchId === undefined) return skipResult(undefined, 'no-qualifying-round', receiptDir, at, dryRun, false);
    // A forced id that EXISTS but is already scored must not be re-scored — a duplicate receipt would inflate
    // the diff count, the day span, and every aggregate metric against the promotion bar (qodo #1). Neither
    // forced-refusal writes a receipt (operator no-ops, like no-qualifying-round).
    const reason = rounds.some((round) => round.dispatchId === options.dispatchId) ? 'already-scored' : 'no-such-round';
    return skipResult(options.dispatchId, reason, receiptDir, at, dryRun, false);
  }

  return dispatchScoreReceipt(selected, { dispatchRunner, workDir, receiptDir, summary, at, dryRun });
}

function pct(value: number | null): string { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

// "calendar days elapsed" (gate 2) is read as the SPAN from the earliest to the latest scored receipt
// (e.g. 09-14 -> 09-19 = 5.0 days), not a count of distinct dates.
function spanDays(scored: readonly ScoredReceipt[]): number {
  const times = scored.map((receipt) => Date.parse(receipt.at)).filter((time) => Number.isFinite(time));
  return times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / 86_400_000;
}

interface ReportTotals { tp: number; fp: number; novel: number; acceptedMatched: number; findingsAccepted: number; findingsTotal: number; hallucinated: number; }

function tick(met: boolean): string { return met ? ' ✓' : ' …'; }

function sumReceipts(scored: readonly ScoredReceipt[]): ReportTotals {
  return scored.reduce((result, receipt) => ({
    tp: result.tp + receipt.tp, fp: result.fp + receipt.fp, novel: result.novel + receipt.novel,
    acceptedMatched: result.acceptedMatched + receipt.acceptedMatched,
    findingsAccepted: result.findingsAccepted + receipt.findingsAccepted,
    findingsTotal: result.findingsTotal + receipt.findingsTotal,
    hallucinated: result.hallucinated + (receipt.hallucinatedCitations ?? 0),
  }), { tp: 0, fp: 0, novel: 0, acceptedMatched: 0, findingsAccepted: 0, findingsTotal: 0, hallucinated: 0 });
}

// The promotion-bar lines. Gate precision is RELATIVE and confirmed-real/raised for BOTH families on the
// same diffs: cloud = findingsAccepted / findingsTotal; local = tp / (tp + fp + novel) — only TP is
// confirmed against ground truth, NOVEL is raised-but-unconfirmed (some may be genuinely real — R's call at
// promotion), so it sits in the denominator. That is a conservative lower bound and IS the gate figure.
function promotionBarLines(scored: readonly ScoredReceipt[], totals: ReportTotals): string[] {
  const raised = totals.tp + totals.fp + totals.novel;
  const localPrecision = raised === 0 ? null : totals.tp / raised;
  const localPrecisionExclNovel = totals.tp + totals.fp === 0 ? null : totals.tp / (totals.tp + totals.fp);
  const cloudPrecision = totals.findingsTotal === 0 ? null : totals.findingsAccepted / totals.findingsTotal;
  const days = spanDays(scored);
  // Gate 4 is KNOWN only when EVERY scored round has been through the file:line post-check (qodo #2): once
  // the check supplies data for only SOME rounds, summing the rest as 0 would let a passing ✓ hide unchecked
  // rounds. Until all are checked the gate stays pending and shows how many are checked.
  const checked = scored.filter((receipt) => receipt.hallucinatedCitations !== undefined).length;
  const hallucinationKnown = scored.length > 0 && checked === scored.length;
  const precisionMeets = localPrecision !== null && cloudPrecision !== null && localPrecision >= cloudPrecision;
  return [
    'Promotion bar (HED-321 — all four must hold; activation stays Maya-gated):',
    `  • diffs: ${scored.length}/${SHADOW_BAR_MIN_DIFFS}${tick(scored.length >= SHADOW_BAR_MIN_DIFFS)}`,
    `  • calendar days elapsed: ${days.toFixed(1)}/${SHADOW_BAR_MIN_DAYS}${tick(days >= SHADOW_BAR_MIN_DAYS)}`,
    `  • precision (confirmed-real/raised, same diffs — the gate): local ${pct(localPrecision)} vs cloud ${pct(cloudPrecision)}${tick(precisionMeets)}`,
    `      context: local excl. NOVEL = ${pct(localPrecisionExclNovel)} (NOVEL counted as raised-but-unconfirmed; final NOVEL handling is R's call at promotion)`,
    `  • hallucinated citations surviving file:line check: ${hallucinationKnown ? `${totals.hallucinated}${tick(totals.hallucinated === 0)}` : `pending — ${checked}/${scored.length} rounds checked`}`,
  ];
}

function pairLines(scored: readonly ScoredReceipt[]): string[] {
  const pairs = new Map<string, ScoredReceipt[]>();
  for (const receipt of scored) {
    const key = `${receipt.reviewerProvider}/${receipt.reviewerModel}`;
    pairs.set(key, [...(pairs.get(key) ?? []), receipt]);
  }
  if (!pairs.size) return [];
  const lines = ["Per incumbent reviewer pair (local vs that pair's cloud precision):"];
  for (const [pair, items] of [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const t = items.reduce((result, receipt) => ({ tp: result.tp + receipt.tp, fp: result.fp + receipt.fp, novel: result.novel + receipt.novel, findingsAccepted: result.findingsAccepted + receipt.findingsAccepted, findingsTotal: result.findingsTotal + receipt.findingsTotal }), { tp: 0, fp: 0, novel: 0, findingsAccepted: 0, findingsTotal: 0 });
    const pairRaised = t.tp + t.fp + t.novel;
    lines.push(`  ${pair}: ${items.length} rounds, local ${pct(pairRaised === 0 ? null : t.tp / pairRaised)} vs cloud ${pct(t.findingsTotal === 0 ? null : t.findingsAccepted / t.findingsTotal)}`);
  }
  return lines;
}

function skipLines(receipts: readonly ShadowReceipt[]): string[] {
  const skips = new Map<string, number>();
  for (const receipt of receipts) if (receipt.status === 'skipped') skips.set(receipt.reason, (skips.get(receipt.reason) ?? 0) + 1);
  if (!skips.size) return [];
  return [`Skipped: ${[...skips.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} (${count})`).join('; ')}`];
}

// Defensive dedup by dispatchId (qodo #1): a forced re-score is now refused, but a historical duplicate or a
// concurrent run must still never inflate the distinct-diff count or aggregates. Keep the LAST receipt per id.
function dedupeScored(receipts: readonly ShadowReceipt[]): ScoredReceipt[] {
  const byId = new Map<number, ScoredReceipt>();
  for (const receipt of receipts) if (receipt.status === 'scored') byId.set(receipt.dispatchId, receipt);
  return [...byId.values()];
}

/**
 * Renders receipt history and progress toward the HED-321 promotion bar (the four gates in the constants
 * above). It only REPORTS — it never makes or applies an activation decision; activation stays Maya-gated.
 * Recall is shown for information only and is deliberately not a gate.
 */
export function renderShadowReport(receipts: readonly ShadowReceipt[]): string {
  const scored = dedupeScored(receipts);
  const totals = sumReceipts(scored);
  const recall = totals.findingsAccepted === 0 ? null : totals.acceptedMatched / totals.findingsAccepted;
  return [
    `${scored.length} rounds scored, ${totals.novel} novel, recall ${pct(recall)} (informational — NOT a promotion gate)`,
    ...promotionBarLines(scored, totals),
    ...pairLines(scored),
    ...skipLines(receipts),
  ].join('\n');
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
