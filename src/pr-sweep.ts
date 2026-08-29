import { execFileSync } from 'node:child_process';
import type { GhRunner } from './pr-own.js';

export type { GhRunner } from './pr-own.js';

export interface DispositionedReview {
  author: string;
  submittedAt: string;
  body: string;
  state: string;
  dispositioned: boolean;
  afterLastPush: boolean;
}

export interface PrSweepData {
  pr: { number: number; title: string; state: string; headSha: string };
  comments: Array<{ author: string; createdAt: string; body: string; afterLastPush: boolean }>;
  reviews: DispositionedReview[];
  undispositionedReviewBodies: DispositionedReview[];
  threads: { total: number; unresolved: Array<{ path: string; author: string; body: string; outdated: boolean }>; overflow: boolean };
  codeScanning: { status: 'ok' | 'unavailable' | 'error'; alerts: unknown[]; error?: string };
  checks: { total: number; nonGreen: Array<{ name: string; conclusion: string }> };
  lateItems: string[];
  mergeState: { mergeable: string; mergeStateStatus: string };
  clean: boolean;
  exitCode: number;
}

export interface PrSweepResult {
  text: string;
  data: PrSweepData;
  exitCode: number;
  error?: string;
}

type ApiComment = { user?: { login?: string }; created_at?: string; body?: string };
type ApiReview = { user?: { login?: string }; submitted_at?: string; state?: string; body?: string };

const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

export function defaultGhRunner(cwd: string): GhRunner {
  return (args) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function normalizeLogin(login: string): string { return login.endsWith('[bot]') ? login.slice(0, -5) : login; }
function iso(value: string): number | null { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
function excerpt(body: string): string {
  const line = body.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '(empty)';
  return line.length > 110 ? `${line.slice(0, 110)}…` : line;
}
function parse<T>(value: string): T { return JSON.parse(value) as T; }
function arrayJson<T>(value: string): T[] {
  const parsed = parse<unknown>(value);
  return Array.isArray(parsed) ? (parsed.flat() as T[]) : [];
}
function paginatedField<T>(value: string, field: string): T[] {
  const parsed = parse<unknown>(value);
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  return pages.flatMap((page) => {
    if (!page || typeof page !== 'object') return [];
    const found = (page as Record<string, unknown>)[field];
    return Array.isArray(found) ? found as T[] : [];
  });
}
function isCodeScanningUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /code scanning.*(not enabled|disabled)|advanced security.*not enabled|must enable.*code scanning/i.test(message);
}
function apiError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function dispositionReceipts(comments: Array<{ body?: string }>): Set<string> {
  const receipts = new Set<string>();
  for (const comment of comments) {
    for (const match of (comment.body ?? '').matchAll(/<!--\s*dispositioned:\s*(\S+)\s+(\S+)\s*-->/g)) {
      receipts.add(`${normalizeLogin(match[1])}\u0000${match[2]}`);
    }
  }
  return receipts;
}

export function isDispositionedReview(review: { author?: { login?: string }; submittedAt?: string }, receipts: Set<string>): boolean {
  return receipts.has(`${normalizeLogin(review.author?.login ?? '?')}\u0000${review.submittedAt ?? ''}`);
}

export function computePrSweepVerdict(input: {
  unresolvedThreadCount: number;
  threadOverflow: boolean;
  openAlertCount: number;
  codeScanningError: boolean;
}): { clean: boolean; exitCode: number; failures: string[] } {
  const failures: string[] = [];
  if (input.unresolvedThreadCount) failures.push(`${input.unresolvedThreadCount} unresolved inline thread(s)`);
  if (input.threadOverflow) failures.push('inline-thread list truncated at 100 — sweep is INCOMPLETE');
  if (input.openAlertCount) failures.push(`${input.openAlertCount} OPEN code-scanning alert(s) for this PR (fix, or dismiss with a reason)`);
  if (input.codeScanningError) failures.push('code-scanning API error — retried once, still failing; failing closed, no scan confirmed');
  return { clean: failures.length === 0, exitCode: failures.length === 0 ? 0 : 2, failures };
}

function fail(error: string, pr: string): PrSweepResult {
  const data: PrSweepData = {
    pr: { number: Number(pr) || 0, title: '', state: '', headSha: '' }, comments: [], reviews: [], undispositionedReviewBodies: [],
    threads: { total: 0, unresolved: [], overflow: false }, codeScanning: { status: 'error', alerts: [], error }, checks: { total: 0, nonGreen: [] },
    lateItems: [], mergeState: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, clean: false, exitCode: 3,
  };
  return { text: `pr-sweep: ${error}`, data, exitCode: 3, error: `pr-sweep: ${error}` };
}

export function runPrSweep(pr: string, cwd: string, gh: GhRunner = defaultGhRunner(cwd)): PrSweepResult {
  if (!/^\d+$/.test(pr)) return fail(`PR must be numeric, got '${pr}'`, pr);
  try {
    const nwo = parse<{ nameWithOwner?: string }>(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
    if (!nwo) return fail('not inside a gh-connected repo', pr);
    const metadata = parse<{ number?: number; title?: string; state?: string; head?: { sha?: string }; mergeable?: boolean | null; mergeable_state?: string }>(gh(['api', `repos/${nwo}/pulls/${pr}`]));
    const commits = arrayJson<{ commit?: { committer?: { date?: string }; author?: { date?: string } } }>(gh(['api', `repos/${nwo}/pulls/${pr}/commits?per_page=100`, '--paginate', '--slurp']));
    const commentsRaw = arrayJson<ApiComment>(gh(['api', `repos/${nwo}/issues/${pr}/comments?per_page=100`, '--paginate', '--slurp']));
    const reviewsRaw = arrayJson<ApiReview>(gh(['api', `repos/${nwo}/pulls/${pr}/reviews?per_page=100`, '--paginate', '--slurp']));
    const [owner, repo] = nwo.split('/', 2);
    const threadsPayload = parse<{ data?: { repository?: { pullRequest?: { reviewThreads?: { totalCount?: number; nodes?: Array<{ isResolved?: boolean; isOutdated?: boolean; path?: string; comments?: { nodes?: Array<{ author?: { login?: string }; body?: string }> } }> } } } } }>(gh(['api', 'graphql', '-f', 'query=query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){totalCount nodes{isResolved isOutdated path comments(first:1){nodes{author{login} body}}}}}}}', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${pr}`]));

    let alerts: unknown[] = [];
    let codeScanning: PrSweepData['codeScanning'] = { status: 'ok', alerts };
    try {
      alerts = arrayJson<unknown>(gh(['api', `repos/${nwo}/code-scanning/alerts?pr=${pr}&state=open&per_page=100`]));
      codeScanning = { status: 'ok', alerts };
    } catch (firstError) {
      try {
        alerts = arrayJson<unknown>(gh(['api', `repos/${nwo}/code-scanning/alerts?pr=${pr}&state=open&per_page=100`]));
        codeScanning = { status: 'ok', alerts };
      } catch (secondError) {
        const error = apiError(secondError);
        codeScanning = isCodeScanningUnavailable(secondError) || isCodeScanningUnavailable(firstError)
          ? { status: 'unavailable', alerts: [], error }
          : { status: 'error', alerts: [], error };
      }
    }

    const headSha = metadata.head?.sha ?? '';
    let checkRuns: Array<{ name?: string; conclusion?: string; status?: string }> = [];
    let statuses: Array<{ context?: string; state?: string }> = [];
    if (headSha) {
      try { checkRuns = paginatedField<typeof checkRuns[number]>(gh(['api', `repos/${nwo}/commits/${headSha}/check-runs?per_page=100`, '--paginate', '--slurp']), 'check_runs'); } catch { /* Checks are informational. */ }
      try { statuses = paginatedField<typeof statuses[number]>(gh(['api', `repos/${nwo}/commits/${headSha}/status?per_page=100`, '--paginate', '--slurp']), 'statuses'); } catch { /* Checks are informational. */ }
    }
    const allChecks: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }> = [...checkRuns, ...statuses];
    const nonGreen = allChecks.map((check) => ({ name: check.name ?? check.context ?? '?', conclusion: (check.conclusion ?? check.state ?? check.status ?? '?').toUpperCase() })).filter((check) => !GREEN.has(check.conclusion));

    const lastPush = Math.max(...commits.map((commit) => iso(commit.commit?.committer?.date ?? commit.commit?.author?.date ?? '') ?? -Infinity));
    const afterPush = (time: string) => Number.isFinite(lastPush) && (iso(time) ?? -Infinity) > lastPush;
    const comments = commentsRaw.map((comment) => ({ author: comment.user?.login ?? '?', createdAt: comment.created_at ?? '', body: comment.body ?? '', afterLastPush: afterPush(comment.created_at ?? '') }));
    const receipts = dispositionReceipts(comments);
    const reviews = reviewsRaw.map((review) => {
      const normalized = { author: review.user?.login ?? '?', submittedAt: review.submitted_at ?? '', state: review.state ?? '', body: (review.body ?? '').trim() };
      return { ...normalized, dispositioned: normalized.body !== '' && isDispositionedReview({ author: { login: normalized.author }, submittedAt: normalized.submittedAt }, receipts), afterLastPush: afterPush(normalized.submittedAt) };
    });
    const undispositionedReviewBodies = reviews.filter((review) => review.body !== '' && !review.dispositioned);
    const nodes = threadsPayload.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const total = threadsPayload.data?.repository?.pullRequest?.reviewThreads?.totalCount ?? nodes.length;
    const unresolved = nodes.filter((thread) => !thread.isResolved).map((thread) => {
      const comment = thread.comments?.nodes?.[0];
      return { path: thread.path ?? '?', author: comment?.author?.login ?? '?', body: comment?.body ?? '', outdated: Boolean(thread.isOutdated) };
    });
    const lateItems = [...comments.filter((comment) => comment.afterLastPush).map((comment) => `comment by ${comment.author}`), ...reviews.filter((review) => review.afterLastPush).map((review) => `review by ${review.author}`)];
    const mergeState = { mergeable: metadata.mergeable === true ? 'MERGEABLE' : metadata.mergeable === false ? 'CONFLICTING' : 'UNKNOWN', mergeStateStatus: (metadata.mergeable_state ?? 'unknown').toUpperCase() };
    const verdict = computePrSweepVerdict({ unresolvedThreadCount: unresolved.length, threadOverflow: total > nodes.length, openAlertCount: codeScanning.alerts.length, codeScanningError: codeScanning.status === 'error' });
    const data: PrSweepData = { pr: { number: metadata.number ?? Number(pr), title: metadata.title ?? '', state: (metadata.state ?? '').toUpperCase(), headSha }, comments, reviews, undispositionedReviewBodies, threads: { total, unresolved, overflow: total > nodes.length }, codeScanning, checks: { total: checkRuns.length + statuses.length, nonGreen }, lateItems, mergeState, clean: verdict.clean, exitCode: verdict.exitCode };
    return { text: render(data, verdict.failures), data, exitCode: verdict.exitCode };
  } catch (error) { return fail(`failed to fetch PR #${pr}: ${apiError(error)}`, pr); }
}

function render(data: PrSweepData, failures: string[]): string {
  const lines = [`══ PR #${data.pr.number} — ${data.pr.title}  [${data.pr.state}]`, `   HEAD ${data.pr.headSha.slice(0, 12)}`, '', `── (a) Issue comments: ${data.comments.length}`];
  for (const comment of data.comments) lines.push(`   • ${comment.author}  ${comment.createdAt}${comment.afterLastPush ? '  ⏰ AFTER last push' : ''}`, `     ${excerpt(comment.body)}`);
  lines.push('', `── (b) Reviews: ${data.reviews.length}`);
  for (const review of data.reviews) lines.push(`   • ${review.author}  ${review.state}  ${review.submittedAt}  ${[review.afterLastPush ? '⏰ AFTER last push' : '', review.dispositioned ? '✓ dispositioned (receipt on record)' : review.body ? '📝 NON-EMPTY BODY — read it' : ''].filter(Boolean).join(' ')}`, ...(review.body ? [`     ${excerpt(review.body)}`] : []));
  lines.push('', `── (c) Inline review threads: ${data.threads.total} total, ${data.threads.unresolved.length} UNRESOLVED`);
  for (const thread of data.threads.unresolved) lines.push(`   ✗ ${thread.path}  by ${thread.author}${thread.outdated ? '  (outdated)' : ''}`, `     ${excerpt(thread.body)}`);
  if (data.threads.overflow) lines.push(`   ⚠️ only first 100 threads fetched — ${data.threads.total - 100} more exist; check the PR page`);
  lines.push('', data.codeScanning.status === 'unavailable' ? '── (d) Code-scanning alerts: code scanning is NOT ENABLED on this repo — benign, pass-by-silence' : data.codeScanning.status === 'error' ? `── (d) Code-scanning API ERROR (not the not-enabled signal) — FAIL-CLOSED${data.codeScanning.error ? ` — ${data.codeScanning.error.slice(0, 120)}` : ''}` : `── (d) Code-scanning alerts OPEN for this PR: ${data.codeScanning.alerts.length}`);
  for (const alert of data.codeScanning.alerts.slice(0, 25)) {
    const item = alert as { number?: unknown; html_url?: unknown; tool?: { name?: unknown }; rule?: { id?: unknown; security_severity_level?: unknown; severity?: unknown }; most_recent_instance?: { location?: { path?: unknown; start_line?: unknown } } };
    const location = item.most_recent_instance?.location;
    const severity = item.rule?.security_severity_level ?? item.rule?.severity ?? '';
    lines.push(`   ✗ #${item.number ?? '?'} [${item.tool?.name ?? '?'}] ${item.rule?.id ?? '?'} — ${location?.path ?? '?'}:${location?.start_line ?? '?'}${severity ? ` (${severity})` : ''}  ${item.html_url ?? ''}`);
  }
  if (data.codeScanning.alerts.length > 25) lines.push(`   … ${data.codeScanning.alerts.length - 25} more — see the Security tab`);
  lines.push(`── (e) Checks at HEAD: ${data.checks.total} total, ${data.checks.nonGreen.length} non-green`);
  for (const check of data.checks.nonGreen) lines.push(`   • ${check.name}: ${check.conclusion}`);
  if (data.checks.total && !data.checks.nonGreen.length) lines.push('   ✓ all green (or skipped)');
  lines.push('', '══ MECHANICAL VERDICT');
  lines.push(failures.length ? `   ✗ NOT CLEAN: ${failures.join('; ')}` : `   ✓ mechanical gates pass (0 unresolved threads; 0 open code-scanning alerts${data.codeScanning.status === 'unavailable' ? ' — code scanning unavailable, checked by hand?' : ''})`);
  if (data.undispositionedReviewBodies.length) lines.push(`   📝 ${data.undispositionedReviewBodies.length} non-empty review bod${data.undispositionedReviewBodies.length === 1 ? 'y' : 'ies'} to read/address: ${[...new Set(data.undispositionedReviewBodies.map((review) => review.author))].sort().join(', ')}`);
  if (data.lateItems.length) lines.push(`   ⏰ ${data.lateItems.length} item(s) landed after the last push — bots land late; re-sweep before declaring clean`);
  if (data.checks.nonGreen.length) lines.push(`   🔴 ${data.checks.nonGreen.length} non-green check(s) at HEAD — read (e) above; only the ruleset knows which are required, and some are red by design`);
  lines.push(`   ⚖️  merge-state AUTHORITY: mergeable=${data.mergeState.mergeable} state=${data.mergeState.mergeStateStatus} (UNKNOWN = still computing — poll before trusting)`);
  if (data.mergeState.mergeStateStatus === 'BLOCKED' && !data.checks.nonGreen.length) lines.push('   🚨 DIVERGENCE: rollup reads green but merge-state is BLOCKED — the ruleset sees a failing/absent required context in the NEWEST SUITE (gh pr checks keys on newest RUN and can lie here). Do NOT trust the green; see HED-142 suite-vs-run semantics.');
  lines.push('   Reminder: the sweep proves completeness, not judgment — read every item above.');
  return lines.join('\n');
}
