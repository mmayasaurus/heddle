#!/usr/bin/env node
/**
 * Reusable, candidate-agnostic quality bench for inline-diff-only adversarial reviewers.
 * The orchestrator runs candidate and judge model dispatches between this CLI's stages.
 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Checkout locations follow the fleet-wide convention (lin.sh, pr-sweep.sh, launchers all hardcode
// /Users/mayatobi/Developer/<repo>). Overridable per-repo for a different clone or CI.
const HEDDLE_REPOS = {
  heddle: { root: process.env.HEDDLE_REPO_ROOT ?? '/Users/mayatobi/Developer/heddle', github: 'mmayasaurus/heddle' },
  'heddle-dashboard': { root: process.env.HEDDLE_DASHBOARD_REPO_ROOT ?? '/Users/mayatobi/Developer/heddle-dashboard', github: 'mmayasaurus/heddle-dashboard' },
} as const;

// d.cwd is prefiltered with a broad '%heddle%' (repoForCwd does the precise, absolute-path scope guard):
// a review whose cwd is EXACTLY a repo root (no trailing slash) must not be dropped by a '%/heddle/%'
// pattern. started_at is the review dispatch's real start time — used to reconstruct the reviewed commit.
const CORPUS_QUERY = `SELECT r.dispatch_id, d.issue, d.cwd, d.started_at, r.author_provider, r.author_model,
       r.reviewer_provider, r.reviewer_model, r.findings_total, r.findings_accepted, r.notes
FROM reviews r JOIN dispatches d ON d.id = r.dispatch_id
WHERE r.outcome_at IS NOT NULL AND r.findings_total > 0
  AND d.issue LIKE 'HED-%'
  AND d.cwd LIKE '%heddle%'
ORDER BY r.dispatch_id DESC;`;

export interface CorpusRound {
  dispatchId: number;
  issue: string;
  repo: keyof typeof HEDDLE_REPOS;
  pr: number;
  authorProvider: string | null;
  authorModel: string | null;
  reviewerProvider: string;
  reviewerModel: string;
  findingsTotal: number;
  findingsAccepted: number;
  notesRaw: string | null;
  /** The commit that was branch HEAD when the incumbent review ran (before its fixes landed). */
  reviewedHead: string;
  /** The branch's fork point from main = merge-base of the merge commit's two parents. */
  forkPoint: string;
  /** The reviewed (pre-fix) diff: `git diff <forkPoint> <reviewedHead>`. */
  diff: string;
}

export interface Skip {
  dispatchId: number;
  issue: string;
  reason: string;
}

export interface CorpusSummary {
  totalRows: number;
  survived: number;
  skipped: Skip[];
  byPair: Record<string, number>;
}

interface LedgerRow {
  dispatch_id: number;
  issue: string;
  cwd: string;
  started_at: string | null;
  author_provider: string | null;
  author_model: string | null;
  reviewer_provider: string;
  reviewer_model: string;
  findings_total: number;
  findings_accepted: number;
  notes: string | null;
}

interface PullRequest {
  number: number;
  body: string | null;
}

interface Commit {
  oid: string;
  committedDate: string;
}

interface PullDetail {
  mergeCommit: { oid: string } | null;
  commits: Commit[];
}

export interface CandidateFinding {
  idx: number;
  class: 'TP' | 'FP' | 'NOVEL';
  matchesAcceptedIncumbent: boolean;
  rationale: string;
}

interface JudgeResult {
  roundId: number;
  candidateFindings: CandidateFinding[];
  acceptedIncumbentMatchedCount: number;
}

export interface NovelFinding {
  idx: number;
  rationale: string;
}

export interface ScoredRound extends CorpusRound {
  tp: number;
  fp: number;
  novel: NovelFinding[];
  acceptedMatched: number;
}

export interface Metrics {
  rounds: number;
  tp: number;
  fp: number;
  novel: number;
  acceptedMatched: number;
  findingsAccepted: number;
  recall: number | null;
  precision: number | null;
  novelPerRound: number | null;
}

export interface ScoreReport {
  candidate: string;
  corpus: CorpusSummary;
  rounds: ScoredRound[];
  totals: Metrics;
  byPair: Record<string, Metrics>;
}

export type GhRunner = (args: readonly string[]) => string;
export type GitRunner = (root: string, args: readonly string[]) => string;

function defaultGh(args: readonly string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function defaultGit(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pairKey(authorProvider: string | null, reviewerProvider: string): string {
  return `${authorProvider ?? 'unknown'}:${reviewerProvider}`;
}

function isUnder(path: string, root: string): boolean {
  if (!isAbsolute(path)) return false;
  const child = resolve(path);
  const parent = resolve(root);
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function repoForCwd(cwd: string): keyof typeof HEDDLE_REPOS | null {
  const repo = cwd.includes('heddle-dashboard') ? 'heddle-dashboard' : 'heddle';
  return isUnder(cwd, HEDDLE_REPOS[repo].root) ? repo : null;
}

function parsePairs(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const pairs = value.split(',').map((pair) => pair.trim()).filter(Boolean);
  if (!pairs.length || pairs.some((pair) => !/^[^:]+:[^:]+$/.test(pair))) {
    throw new Error('--pairs must be a comma-separated author:reviewer list');
  }
  return [...new Set(pairs)];
}

function selectRows(rows: LedgerRow[], limit: number | undefined, pairs: string[] | undefined): LedgerRow[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const pair = pairKey(row.author_provider, row.reviewer_provider);
    if (pairs && !pairs.includes(pair)) continue;
    const group = groups.get(pair) ?? [];
    group.push(row);
    groups.set(pair, group);
  }
  const keys = pairs ?? [...groups.keys()].sort();
  if (limit === undefined) return keys.flatMap((key) => groups.get(key) ?? []).sort((a, b) => b.dispatch_id - a.dispatch_id);

  const selected: LedgerRow[] = [];
  const offsets = new Map(keys.map((key) => [key, 0]));
  while (selected.length < limit) {
    let tookAny = false;
    for (const key of keys) {
      const group = groups.get(key) ?? [];
      const offset = offsets.get(key) ?? 0;
      if (offset >= group.length || selected.length >= limit) continue;
      selected.push(group[offset]!);
      offsets.set(key, offset + 1);
      tookAny = true;
    }
    if (!tookAny) break;
  }
  return selected.sort((a, b) => b.dispatch_id - a.dispatch_id);
}

function issueFixesPattern(issue: string): RegExp {
  return new RegExp(`Fixes\\s+${issue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

function fetchMergedPulls(repo: keyof typeof HEDDLE_REPOS, gh: GhRunner): PullRequest[] {
  // A deterministic issue->PR map needs the FULL merged-PR set, NOT GitHub's `--search`: that search is
  // relevance-ranked, capped, and eventually-consistent, so it returns different subsets per call and
  // would map a multi-PR issue (a fix + a follow-up both saying "Fixes HED-n") to an ARBITRARY PR
  // instead of skipping — feeding the candidate a diff the incumbent never reviewed. The list API is
  // stable; 500 covers the repo's whole merged history. Filtering happens locally, in mapMergedPullRequest.
  const raw = gh(['pr', 'list', '-R', HEDDLE_REPOS[repo].github, '--state', 'merged', '--limit', '500', '--json', 'number,title,headRefName,body']);
  return JSON.parse(raw) as PullRequest[];
}

function mapMergedPullRequest(issue: string, pulls: readonly PullRequest[]): number | null {
  const matches = pulls.filter((pull) => Number.isInteger(pull.number) && issueFixesPattern(issue).test(pull.body ?? ''));
  return matches.length === 1 ? matches[0]!.number : null;
}

function fetchPullDetail(pr: number, repo: keyof typeof HEDDLE_REPOS, gh: GhRunner): PullDetail {
  return JSON.parse(gh(['pr', 'view', String(pr), '-R', HEDDLE_REPOS[repo].github, '--json', 'mergeCommit,commits'])) as PullDetail;
}

/**
 * Reconstruct the EXACT diff the incumbent reviewed, not the merged diff.
 *
 * A merged PR's diff is POST-fix: it already contains the changes that resolved the incumbent's accepted
 * findings, so a candidate replayed against it cannot rediscover those defects and recall collapses toward
 * zero. The reviewer instead saw the branch at its last commit BEFORE the review ran, diffed against the
 * branch's fork point from main. Because the PR later merged, that reviewed commit is now an ancestor of
 * main, so a `main...reviewedHead` diff is empty — the fork point survives only in the merge commit's two
 * parents (merge-base(P1, P2)). This repo merges with merge commits (never squash/rebase), so every PR has
 * a 2-parent merge commit; a non-2-parent merge is skipped rather than reconstructed wrong.
 */
export function reconstructReviewedDiff(
  pr: number,
  repo: keyof typeof HEDDLE_REPOS,
  startedAt: string | null,
  gh: GhRunner,
  git: GitRunner,
): { diff: string; reviewedHead: string; forkPoint: string } | { skip: string } {
  if (!startedAt) return { skip: 'no-started-at' };
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return { skip: 'bad-started-at' };
  const detail = fetchPullDetail(pr, repo, gh);
  if (!detail.mergeCommit?.oid) return { skip: 'no-merge-commit' };
  const root = HEDDLE_REPOS[repo].root;
  const parents = git(root, ['rev-list', '--parents', '-n', '1', detail.mergeCommit.oid]).trim().split(/\s+/).slice(1);
  if (parents.length !== 2) return { skip: `non-merge-commit(${parents.length}p)` };
  const forkPoint = git(root, ['merge-base', parents[0]!, parents[1]!]).trim();
  // Compare by parsed epoch, never lexically: `committedDate` has second precision and started_at has
  // milliseconds, so a same-second commit would misorder under a string compare (…47Z vs …47.938Z).
  const preReview = (detail.commits ?? []).filter((commit) => Date.parse(commit.committedDate) < startedMs);
  if (!preReview.length) return { skip: 'no-pre-review-commit' };
  const reviewedHead = preReview.reduce((latest, commit) => (Date.parse(commit.committedDate) >= Date.parse(latest.committedDate) ? commit : latest)).oid;
  const diff = git(root, ['diff', forkPoint, reviewedHead]);
  return { diff, reviewedHead, forkPoint };
}

function readCorpus(dir: string): CorpusRound[] {
  const path = join(dir, 'corpus.jsonl');
  if (!existsSync(path)) throw new Error(`corpus not found: ${path}`);
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CorpusRound);
}

function readSummary(dir: string): CorpusSummary {
  const path = join(dir, 'corpus-summary.json');
  if (!existsSync(path)) throw new Error(`corpus summary not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as CorpusSummary;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function summarizeCorpus(totalRows: number, rounds: CorpusRound[], skipped: Skip[]): CorpusSummary {
  const byPair: Record<string, number> = {};
  for (const item of rounds) {
    const key = pairKey(item.authorProvider, item.reviewerProvider);
    byPair[key] = (byPair[key] ?? 0) + 1;
  }
  return { totalRows, survived: rounds.length, skipped, byPair: Object.fromEntries(Object.entries(byPair).sort(([a], [b]) => a.localeCompare(b))) };
}

export function buildCandidatePrompt(outDir: string, round: CorpusRound): string {
  mkdirSync(outDir, { recursive: true });
  const prompt = [
    'Adversarially review this diff — it is prepended below. You have NO repository access and NO code-discovery tools; judge ONLY from the diff shown. Report concrete, actionable findings (correctness, security, regressions, test quality) — each with severity (high/med/low), file:line, and a one-line description. Do not speculate about code you cannot see in the diff. Number findings F1, F2, …, then end with `VERDICT: <n> findings (<h> high, <m> med, <l> low)`.',
    '',
    round.diff,
  ].join('\n');
  const path = join(outDir, `prompt-${round.dispatchId}.txt`);
  writeFileSync(path, prompt);
  return path;
}

function judgePrompt(round: CorpusRound, candidateRaw: string): string {
  return [
    'You are the judge for an adversarial-review quality bench. The DIFF below is the EXACT version the incumbent reviewer saw: it is reconstructed at the commit that was branch HEAD when the incumbent review ran, BEFORE any fixes for its findings were pushed. So every ACCEPTED incumbent finding describes a defect that IS present in this diff. Accepted incumbent findings are ground truth. Return STRICT JSON only, with no Markdown fences or prose:',
    '{"roundId": <dispatchId>,',
    ' "candidateFindings": [{"idx": 1, "class": "TP|FP|NOVEL", "matchesAcceptedIncumbent": true|false, "rationale": "<=200 chars"}],',
    ' "acceptedIncumbentMatchedCount": <int 0..findingsAccepted>}',
    '',
    'MATCH ON THE DEFECT, NOT THE WORDING. Classify a candidate finding TP when it identifies the SAME underlying defect as an ACCEPTED incumbent finding — the same file/code region and the same failure class count as a match even if the line number, phrasing, or severity differ. Do NOT require identical wording and do NOT penalise the candidate for describing the defect differently.',
    'The incumbent had repository-wide code-discovery tools (memtrace); the candidate saw only this diff. An accepted incumbent finding that depends on code NOT visible in this diff is legitimately un-findable by the candidate — do not invent a match for it, but still keep it in findingsAccepted (the recall denominator).',
    'TP = same defect as an ACCEPTED incumbent finding (matchesAcceptedIncumbent MUST be true).',
    'FP = matches an incumbent finding REJECTED as a false positive, OR is unsupported by the diff (matchesAcceptedIncumbent MUST be false).',
    'NOVEL = a plausibly-real issue visible in the diff the incumbent did not raise (matchesAcceptedIncumbent MUST be false).',
    'acceptedIncumbentMatchedCount = how many DISTINCT accepted incumbent findings the candidate caught (recall numerator; 0..findingsAccepted). One candidate finding may match more than one accepted finding.',
    '',
    'DIFF:',
    round.diff,
    '',
    `Round ID: ${round.dispatchId}`,
    `Incumbent counts: findingsTotal=${round.findingsTotal}; findingsAccepted=${round.findingsAccepted}`,
    'Incumbent outcome (notesRaw):',
    round.notesRaw ?? '(no notes recorded)',
    '',
    'Candidate findings (raw):',
    candidateRaw,
  ].join('\n');
}

/**
 * Extract the judge's JSON result, tolerating prose or Markdown fences around it. Collect every balanced,
 * parseable top-level object and prefer the one carrying a `roundId` key — so an example object emitted
 * before the real answer (a common LLM habit) is never mistaken for the result.
 */
export function extractJudgeJson(raw: string): unknown {
  const objects: unknown[] = [];
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < raw.length; end += 1) {
      const char = raw[end]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { objects.push(JSON.parse(raw.slice(start, end + 1))); start = end; } catch { /* not JSON here; resume from the next opening brace */ }
          break;
        }
      }
    }
  }
  const withRound = objects.find((obj) => !!obj && typeof obj === 'object' && 'roundId' in (obj as object));
  if (withRound !== undefined) return withRound;
  if (objects.length) return objects[0];
  throw new Error('judge output did not contain a JSON object');
}

export function asJudgeResult(value: unknown, round: CorpusRound): JudgeResult {
  if (!value || typeof value !== 'object') throw new Error(`judge-${round.dispatchId}: result must be an object`);
  const data = value as Partial<JudgeResult>;
  if (data.roundId !== round.dispatchId) throw new Error(`judge-${round.dispatchId}: roundId does not match corpus`);
  if (!Array.isArray(data.candidateFindings)) throw new Error(`judge-${round.dispatchId}: candidateFindings must be an array`);
  if (!Number.isInteger(data.acceptedIncumbentMatchedCount) || data.acceptedIncumbentMatchedCount! < 0 || data.acceptedIncumbentMatchedCount! > round.findingsAccepted) {
    throw new Error(`judge-${round.dispatchId}: acceptedIncumbentMatchedCount must be 0..${round.findingsAccepted}`);
  }
  const findings = data.candidateFindings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || !['TP', 'FP', 'NOVEL'].includes(finding.class) || !Number.isInteger(finding.idx) || typeof finding.matchesAcceptedIncumbent !== 'boolean' || typeof finding.rationale !== 'string') {
      throw new Error(`judge-${round.dispatchId}: candidate finding ${index + 1} is invalid`);
    }
    // TP and matchesAcceptedIncumbent are the same claim — a match IS a true positive and vice versa. Reject
    // a judge that disagrees with itself, so the recall numerator (matched) and precision (class) stay coherent.
    if ((finding.class === 'TP') !== finding.matchesAcceptedIncumbent) {
      throw new Error(`judge-${round.dispatchId}: finding ${index + 1} — class TP must match matchesAcceptedIncumbent`);
    }
    return finding as CandidateFinding;
  });
  return { roundId: data.roundId!, candidateFindings: findings, acceptedIncumbentMatchedCount: data.acceptedIncumbentMatchedCount! };
}

function metrics(rounds: ScoredRound[]): Metrics {
  const raw = rounds.reduce((result, round) => ({
    rounds: result.rounds + 1,
    tp: result.tp + round.tp,
    fp: result.fp + round.fp,
    novel: result.novel + round.novel.length,
    acceptedMatched: result.acceptedMatched + round.acceptedMatched,
    findingsAccepted: result.findingsAccepted + round.findingsAccepted,
  }), { rounds: 0, tp: 0, fp: 0, novel: 0, acceptedMatched: 0, findingsAccepted: 0 });
  return {
    ...raw,
    recall: raw.findingsAccepted === 0 ? null : raw.acceptedMatched / raw.findingsAccepted,
    precision: raw.tp + raw.fp === 0 ? null : raw.tp / (raw.tp + raw.fp),
    novelPerRound: raw.rounds === 0 ? null : raw.novel / raw.rounds,
  };
}

export function aggregateScoredRounds(candidate: string, rounds: ScoredRound[], corpus: CorpusSummary): ScoreReport {
  const grouped = new Map<string, ScoredRound[]>();
  for (const round of rounds) {
    const key = pairKey(round.authorProvider, round.reviewerProvider);
    const group = grouped.get(key) ?? [];
    group.push(round);
    grouped.set(key, group);
  }
  return {
    candidate,
    corpus,
    rounds,
    totals: metrics(rounds),
    byPair: Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, metrics(group)])),
  };
}

function buildCorpus(
  out: string,
  opts: { limit?: number; pairs?: string[] },
  gh: GhRunner = defaultGh,
  git: GitRunner = defaultGit,
  ledgerPath = process.env.HEDDLE_LEDGER || join(homedir(), '.heddle', 'ledger.db'),
): CorpusSummary {
  if (!existsSync(ledgerPath)) throw new Error(`ledger not found: ${ledgerPath}`);
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  let allRows: LedgerRow[];
  try { allRows = db.prepare(CORPUS_QUERY).all() as unknown as LedgerRow[]; } finally { db.close(); }
  const rows = selectRows(allRows, opts.limit, opts.pairs);
  const rounds: CorpusRound[] = [];
  const skipped: Skip[] = [];
  const pullsByRepo = new Map<keyof typeof HEDDLE_REPOS, PullRequest[]>();
  const fetched = new Set<keyof typeof HEDDLE_REPOS>();
  for (const row of rows) {
    const repo = repoForCwd(row.cwd);
    if (!repo) {
      skipped.push({ dispatchId: row.dispatch_id, issue: row.issue, reason: 'scope-skip' });
      continue;
    }
    let pulls = pullsByRepo.get(repo);
    if (!pulls) { pulls = fetchMergedPulls(repo, gh); pullsByRepo.set(repo, pulls); }
    const pr = mapMergedPullRequest(row.issue, pulls);
    if (pr === null) {
      skipped.push({ dispatchId: row.dispatch_id, issue: row.issue, reason: 'ambiguous-pr-map' });
      continue;
    }
    // Reconstruction needs the reviewed commit + merge commit present locally; fetch each repo once.
    if (!fetched.has(repo)) { git(HEDDLE_REPOS[repo].root, ['fetch', 'origin', '--quiet']); fetched.add(repo); }
    const reconstructed = reconstructReviewedDiff(pr, repo, row.started_at, gh, git);
    if ('skip' in reconstructed) {
      skipped.push({ dispatchId: row.dispatch_id, issue: row.issue, reason: reconstructed.skip });
      continue;
    }
    const { diff, reviewedHead, forkPoint } = reconstructed;
    const lines = diff === '' ? 0 : diff.split(/\r?\n/).length - (diff.endsWith('\n') ? 1 : 0);
    if (lines === 0 || lines > 4000) {
      skipped.push({ dispatchId: row.dispatch_id, issue: row.issue, reason: lines === 0 ? 'empty-diff' : 'oversize-diff' });
      continue;
    }
    rounds.push({
      dispatchId: row.dispatch_id, issue: row.issue, repo, pr,
      authorProvider: row.author_provider, authorModel: row.author_model,
      reviewerProvider: row.reviewer_provider, reviewerModel: row.reviewer_model,
      findingsTotal: row.findings_total, findingsAccepted: row.findings_accepted,
      notesRaw: row.notes, reviewedHead, forkPoint, diff,
    });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'corpus.jsonl'), rounds.map((round) => JSON.stringify(round)).join(rounds.length ? '\n' : '') + (rounds.length ? '\n' : ''));
  const summary = summarizeCorpus(allRows.length, rounds, skipped);
  writeJson(join(out, 'corpus-summary.json'), summary);
  return summary;
}

function makeCandidatePrompts(corpusDir: string, out: string): number {
  const rounds = readCorpus(corpusDir);
  for (const round of rounds) buildCandidatePrompt(out, round);
  return rounds.length;
}

function makeJudgePrompts(corpusDir: string, candidateOut: string, out: string): number {
  let written = 0;
  mkdirSync(out, { recursive: true });
  for (const round of readCorpus(corpusDir)) {
    const candidatePath = join(candidateOut, `cand-${round.dispatchId}.md`);
    if (!existsSync(candidatePath)) continue;
    writeFileSync(join(out, `judge-${round.dispatchId}.txt`), judgePrompt(round, readFileSync(candidatePath, 'utf8')));
    written += 1;
  }
  return written;
}

function score(corpusDir: string, judgeOut: string, candidate: string): ScoreReport {
  const rounds: ScoredRound[] = [];
  for (const round of readCorpus(corpusDir)) {
    const path = join(judgeOut, `judge-${round.dispatchId}.json`);
    if (!existsSync(path)) continue;
    const judge = asJudgeResult(extractJudgeJson(readFileSync(path, 'utf8')), round);
    const novel = judge.candidateFindings.filter((finding) => finding.class === 'NOVEL').map(({ idx, rationale }) => ({ idx, rationale }));
    rounds.push({
      ...round,
      tp: judge.candidateFindings.filter((finding) => finding.class === 'TP').length,
      fp: judge.candidateFindings.filter((finding) => finding.class === 'FP').length,
      novel,
      acceptedMatched: judge.acceptedIncumbentMatchedCount,
    });
  }
  return aggregateScoredRounds(candidate, rounds, readSummary(corpusDir));
}

function pct(value: number | null): string { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }
function markdownCell(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', ' '); }

function renderReport(score: ScoreReport): string {
  const lines = [
    `# Adversarial-review quality bench — ${score.candidate}`,
    '',
    `> Diffs are reconstructed at the reviewed commit (branch HEAD before the incumbent's fixes landed), so each accepted finding's defect is present in the diff the candidate saw.`,
    `> Deployment-condition confound — incumbent findings were produced WITH code-discovery MCP (memtrace); the candidate ran inline-diff-only (mcp:[]). This bench measures exactly that deployment delta; it is not controlled for.`,
    '',
    '## Headline',
    '',
    `Recall: **${pct(score.totals.recall)}** (${score.totals.acceptedMatched}/${score.totals.findingsAccepted} accepted incumbent findings matched).`,
    '',
    '| Candidate | Rounds | Recall | Precision (cannot discriminate: incumbent acceptance 89–96%) | TP | FP | NOVEL | NOVEL/round |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${markdownCell(score.candidate)} | ${score.totals.rounds} | ${pct(score.totals.recall)} | ${pct(score.totals.precision)} | ${score.totals.tp} | ${score.totals.fp} | ${score.totals.novel} | ${score.totals.novelPerRound === null ? 'n/a' : score.totals.novelPerRound.toFixed(2)} |`,
    '',
    '## Stratification — author → reviewer pair',
    '',
    '| Author → reviewer | Rounds | Recall | Precision (cannot discriminate: incumbent acceptance 89–96%) | TP | FP | NOVEL |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(score.byPair).map(([pair, metric]) => `| ${markdownCell(pair.replace(':', ' → '))} | ${metric.rounds} | ${pct(metric.recall)} | ${pct(metric.precision)} | ${metric.tp} | ${metric.fp} | ${metric.novel} |`),
    '',
    '## NOVEL — unverified, Maya spot-checks',
    '',
    '| Round | Author → reviewer | Finding | Rationale |',
    '| ---: | --- | ---: | --- |',
    ...score.rounds.flatMap((round) => round.novel.map((novel) => `| ${round.dispatchId} | ${markdownCell(pairKey(round.authorProvider, round.reviewerProvider).replace(':', ' → '))} | F${novel.idx} | ${markdownCell(novel.rationale)} |`)),
    '',
    '## Corpus',
    '',
    `Included rounds: ${score.corpus.survived}/${score.corpus.totalRows}.`,
    '',
    '| Author → reviewer | Included rounds |',
    '| --- | ---: |',
    ...Object.entries(score.corpus.byPair).map(([pair, count]) => `| ${markdownCell(pair.replace(':', ' → '))} | ${count} |`),
    '',
    'Skipped rounds:',
    '',
    ...(score.corpus.skipped.length ? score.corpus.skipped.map((skip) => `- ${skip.dispatchId} (${skip.issue}): ${skip.reason}`) : ['- None.']),
    '',
  ];
  return lines.join('\n');
}

function parseCli(args: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = args;
  if (!command) throw new Error('usage: bench-adversarial-review <build-corpus|make-candidate-prompts|make-judge-prompts|score|report> [options]');
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || flags.has(flag)) throw new Error(`invalid option near ${flag ?? '(end)'}`);
    flags.set(flag, value);
  }
  return { command, flags };
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function ensureOnly(flags: Map<string, string>, allowed: string[]): void {
  for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error(`unsupported option: ${flag}`);
}

export function runCli(args: string[]): string {
  const { command, flags } = parseCli(args);
  if (command === 'build-corpus') {
    ensureOnly(flags, ['--out', '--limit', '--pairs']);
    const rawLimit = flags.get('--limit');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
    const summary = buildCorpus(required(flags, '--out'), { limit, pairs: parsePairs(flags.get('--pairs')) });
    return JSON.stringify(summary);
  }
  if (command === 'make-candidate-prompts') {
    ensureOnly(flags, ['--corpus', '--out']);
    return JSON.stringify({ prompts: makeCandidatePrompts(required(flags, '--corpus'), required(flags, '--out')) });
  }
  if (command === 'make-judge-prompts') {
    ensureOnly(flags, ['--corpus', '--candidate-out', '--candidate', '--out']);
    const candidate = required(flags, '--candidate'); // Required to make the handoff explicit in operator invocations.
    return JSON.stringify({ candidate, prompts: makeJudgePrompts(required(flags, '--corpus'), required(flags, '--candidate-out'), required(flags, '--out')) });
  }
  if (command === 'score') {
    ensureOnly(flags, ['--corpus', '--judge-out', '--candidate', '--out']);
    const report = score(required(flags, '--corpus'), required(flags, '--judge-out'), required(flags, '--candidate'));
    writeJson(required(flags, '--out'), report);
    return JSON.stringify({ scored: report.rounds.length, out: required(flags, '--out') });
  }
  if (command === 'report') {
    ensureOnly(flags, ['--scored', '--out']);
    const scored = JSON.parse(readFileSync(required(flags, '--scored'), 'utf8')) as ScoreReport;
    const out = required(flags, '--out');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderReport(scored));
    return JSON.stringify({ out });
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.stdout.write(`${runCli(process.argv.slice(2))}\n`); } catch (error) {
    process.stderr.write(`bench-adversarial-review: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
