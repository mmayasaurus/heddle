import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type GhRunner } from './pr-own.js';

export type { GhRunner } from './pr-own.js';

export interface PrWatchOptions {
  repo?: string;
  seed?: boolean;
  reset?: boolean;
  /** Injectable for tests; defaults to HEDDLE_PR_WATCH_STATE_DIR or ~/.heddle/pr-watch. */
  stateDir?: string;
  gateCheck?: string;
}

export interface PrWatchResult {
  code: number;
  lines: string[];
  data: {
    pr: number;
    repo: string;
    sha: string;
    emitted: string[];
    seeded: boolean;
    stateFile?: string;
  };
  error?: string;
}

type ReviewThread = { id?: string; isResolved?: boolean; comments?: { nodes?: Array<{ author?: { login?: string }; path?: string; line?: number | null }> } };
type Review = { author?: { login?: string }; submittedAt?: string; state?: string; body?: string | null };
type StatusCheck = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string | null };

export function defaultGhRunner(cwd: string): GhRunner {
  return (args) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Keep state names portable even for repositories passed as owner/repo. */
export function formatWatchStateFile(stateDir: string, repo: string, pr: string): string {
  return join(stateDir, `${repo.replace(/[/:]/g, '_')}-${pr}.seen`);
}

/** Pure membership helper, shared by the poller and direct unit tests. */
export function hasSeenKey(contents: string, key: string): boolean {
  return contents.split(/\r?\n/).some((line) => line === key);
}

function stateDirectory(options: PrWatchOptions): string {
  // This pack is repo-agnostic: it must not inherit a consumer project's ~/.claude state location.
  return options.stateDir ?? process.env.HEDDLE_PR_WATCH_STATE_DIR ?? process.env.PR_WATCH_STATE_DIR ?? join(homedir(), '.heddle', 'pr-watch');
}
function parse<T>(raw: string): T { return JSON.parse(raw) as T; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function ghRepoNwo(gh: GhRunner): string | null {
  try { return parse<{ nameWithOwner?: string }>(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner?.trim() || null; }
  catch { return null; }
}
function usage(pr: string): PrWatchResult {
  return { code: 2, lines: [], data: { pr: Number(pr) || 0, repo: '', sha: '?', emitted: [], seeded: false }, error: `pr-watch: PR must be numeric, got '${pr}'` };
}

export function runPrWatch(pr: string, options: PrWatchOptions, cwd: string, gh: GhRunner = defaultGhRunner(cwd)): PrWatchResult {
  if (!/^\d+$/.test(pr)) return usage(pr);

  let repo = options.repo?.trim() ?? '';
  if (!repo) {
    // Match pr-watch.sh: gh's default-repository resolution may intentionally differ from origin.
    repo = ghRepoNwo(gh) ?? '';
  }
  if (!repo || !repo.includes('/')) {
    return { code: 2, lines: [], data: { pr: Number(pr), repo: '', sha: '?', emitted: [], seeded: Boolean(options.seed) }, error: 'pr-watch: no repo (pass --repo owner/repo or run inside a repo)' };
  }

  const dir = stateDirectory(options);
  const stateFile = formatWatchStateFile(dir, repo, pr);
  let stateError: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    if (options.reset || !existsSync(stateFile)) writeFileSync(stateFile, '');
  } catch (error) { stateError = message(error); }
  let seen = '';
  if (!stateError) try { seen = readFileSync(stateFile, 'utf8'); } catch (error) { stateError = message(error); }
  const lines: string[] = [];
  if (stateError) lines.push(`[watch-error] state read/append failed (${stateError}) — continuing without durable dedup`);
  const emit = (key: string, display: string): void => {
    if (!stateError && hasSeenKey(seen, key)) return;
    if (!stateError) try {
      appendFileSync(stateFile, `${key}\n`);
      seen += `${key}\n`;
    } catch (error) {
      stateError = message(error);
      lines.push(`[watch-error] state read/append failed (${stateError}) — continuing without durable dedup`);
    }
    if (!options.seed) lines.push(display);
  };

  let sha = '?';
  try {
    sha = (parse<{ headRefOid?: string }>(gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid'])).headRefOid ?? '').slice(0, 9) || '?';
  } catch { /* A channel failure below still emits a durable watch error keyed to unknown SHA. */ }
  const [owner, name] = repo.split('/', 2);

  try {
    const payload = parse<{ data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: ReviewThread[] } } } } }>(gh([
      'api', 'graphql', '-f', 'query=query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(last:100){nodes{id isResolved comments(first:1){nodes{author{login} path line}}}}}}}',
      '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${pr}`,
    ]));
    for (const thread of payload.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      if (thread.isResolved || !thread.id) continue;
      const comment = thread.comments?.nodes?.[0];
      const author = comment?.author?.login ?? '?';
      const path = comment?.path ?? '?';
      const line = comment?.line ?? 0;
      emit(`thread:${thread.id}`, `[thread] ${author} ${path}:${line} id=${thread.id}`);
    }
  } catch {
    emit(`watch-error:threads:${sha}`, '[watch-error] review-threads query failed (gh/graphql) — re-check auth/rate-limit; heddle pr sweep is authoritative');
  }

  try {
    const reviews = parse<{ reviews?: Review[] }>(gh(['pr', 'view', pr, '--repo', repo, '--json', 'reviews'])).reviews ?? [];
    for (const review of reviews) {
      if (!(review.body ?? '').trim()) continue;
      const author = review.author?.login ?? '?';
      const timestamp = review.submittedAt ?? '';
      emit(`review:${author}@${timestamp}`, `[review] ${author} ${review.state ?? ''} @${timestamp}`);
    }
  } catch {
    emit(`watch-error:reviews:${sha}`, '[watch-error] reviews query failed (gh) — re-check auth/rate-limit; heddle pr sweep is authoritative');
  }

  // `gate` makes this usable out of the box; packs for repos with another required check can override it.
  const gateCheck = options.gateCheck ?? process.env.HEDDLE_PR_GATE_CHECK ?? 'gate';
  try {
    const checks = parse<{ statusCheckRollup?: StatusCheck[] }>(gh(['pr', 'view', pr, '--repo', repo, '--json', 'statusCheckRollup'])).statusCheckRollup ?? [];
    for (const check of checks) {
      if ((check.name ?? check.context ?? '') !== gateCheck) continue;
      if (check.status !== 'COMPLETED' && !check.conclusion && !check.state) continue;
      const conclusion = check.conclusion ?? check.state ?? 'UNKNOWN';
      emit(`gate:${sha}:${conclusion}`, `[gate] ${conclusion} @${sha}`);
    }
  } catch {
    emit(`watch-error:gate:${sha}`, '[watch-error] gate/status query failed (gh) — re-check auth/rate-limit; heddle pr sweep is authoritative');
  }

  return { code: 0, lines, data: { pr: Number(pr), repo, sha, emitted: lines, seeded: Boolean(options.seed), stateFile } };
}
