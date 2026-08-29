import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MARK_PREFIX = '<!-- PR-OWNER';
const LABEL = 'claimed';
const LABEL_DESCRIPTION = 'A worktree owns/drives this PR (see pr-ownership.md)';

export interface OwnerIdInput {
  topLevel: string;
  branch: string | null;
  override?: string;
}

export interface PrOwnerMarker {
  owner: string;
  since: string;
  heartbeat: string;
}

export interface PrOwnResult {
  code: number;
  data: Record<string, unknown>;
  text: string;
  error?: string;
}

export type GhRunner = (args: string[]) => string;

function pathHash(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 8);
}

/**
 * Worktrees already have a filesystem-unique lane name. A bare checkout needs its branch name;
 * main additionally carries a path suffix because main is the known cross-repository collision.
 */
export function deriveOwnerId({ topLevel, branch, override }: OwnerIdInput): string {
  if (override?.trim()) return override.trim();
  const normalized = resolve(topLevel);
  const match = normalized.match(/(?:^|\/)\.worktrees\/([^/]+)(?:\/|$)/);
  if (match?.[1]) return match[1];
  if (!branch) return pathHash(normalized);
  return branch === 'main' ? `main-${pathHash(normalized)}` : branch;
}

export function markerBody(owner: string, since: string, heartbeat: string): string {
  return `${MARK_PREFIX} owner=${owner} since=${since} heartbeat=${heartbeat} -->\n\n` +
    '_PR ownership marker — managed by `heddle pr own`. Owner = the worktree driving this PR to green._';
}

export function parseMarker(body: string): PrOwnerMarker | null {
  if (!body.startsWith(MARK_PREFIX)) return null;
  const fields = Object.fromEntries([...body.matchAll(/\b(owner|since|heartbeat)=([^\s]+)/g)].map(([, key, value]) => [key, value]));
  if (!fields.owner || !fields.since || !fields.heartbeat) return null;
  return { owner: fields.owner, since: fields.since, heartbeat: fields.heartbeat };
}

function nowIso(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function staleHours(): number {
  const parsed = Number(process.env.HEDDLE_PR_OWN_STALE_HOURS ?? '4');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
}
function ageHours(heartbeat: string): number {
  const then = Date.parse(heartbeat);
  return Number.isNaN(then) ? 9999 : Math.floor((Date.now() - then) / 3_600_000);
}
function failOpen(message: string): PrOwnResult {
  return { code: 0, data: { ok: false, error: message }, text: '', error: `pr-own: ${message}` };
}
function result(code: number, text: string, data: Record<string, unknown> = {}): PrOwnResult {
  return { code, text, data: { ok: code === 0, ...data } };
}

export function defaultGhRunner(cwd: string): GhRunner {
  return (args) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitText(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function ownerIdForCwd(cwd: string, override = process.env.HEDDLE_PR_OWNER): string {
  const topLevel = gitText(cwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return override?.trim() || pathHash(cwd);
  const branch = gitText(cwd, ['branch', '--show-current']) || null;
  return deriveOwnerId({ topLevel, branch, override });
}

interface Comment { body: string; url?: string; }
function latestMarker(comments: Comment[]): { marker: PrOwnerMarker; id?: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const marker = parseMarker(comments[i].body);
    if (marker) return { marker, id: comments[i].url?.match(/issuecomment-(\d+)$/)?.[1] };
  }
  return null;
}
function prComments(gh: GhRunner, pr: string): { marker: PrOwnerMarker; id?: string } | null {
  const raw = gh(['pr', 'view', pr, '--json', 'comments']);
  const parsed = JSON.parse(raw) as { comments?: Comment[] };
  return latestMarker(parsed.comments ?? []);
}
function ensureLabel(gh: GhRunner): void {
  try { gh(['label', 'create', LABEL, '--color', 'BFDADC', '--description', LABEL_DESCRIPTION]); } catch { /* Label may already exist. */ }
}
function addLabel(gh: GhRunner, pr: string): void {
  try { gh(['pr', 'edit', pr, '--add-label', LABEL]); } catch { /* The marker remains authoritative. */ }
}

export function runPrOwn(command: string | undefined, pr: string | undefined, cwd: string, gh: GhRunner = defaultGhRunner(cwd)): PrOwnResult {
  const me = ownerIdForCwd(cwd);
  if (command === 'whoami') return result(0, me, { owner: me });
  if (!['claim', 'check', 'release', 'mine'].includes(command ?? '')) {
    return failOpen('usage: heddle pr own {whoami|claim <pr#>|check <pr#>|release <pr#>|mine}');
  }
  if (command !== 'mine' && !pr) return failOpen(`usage: heddle pr own ${command} <pr#>`);

  try {
    if (command === 'check') {
      const latest = prComments(gh, pr!);
      if (!latest) return result(0, `UNOWNED — PR #${pr} has no owner. Claim it before you work it: heddle pr own claim ${pr}`, { verdict: 'UNOWNED', pr: Number(pr) });
      const { marker } = latest;
      const age = ageHours(marker.heartbeat);
      if (marker.owner === 'released') return result(0, `RELEASED — PR #${pr} was handed off by its prior owner and is free to adopt: heddle pr own claim ${pr}`, { verdict: 'RELEASED', pr: Number(pr), owner: marker.owner });
      if (marker.owner === me) return result(0, `YOURS — you (${me}) own PR #${pr} (heartbeat ${age}h ago). Proceed.`, { verdict: 'YOURS', pr: Number(pr), owner: me, ageHours: age });
      if (age >= staleHours()) return result(0, `STALE — PR #${pr} was owned by '${marker.owner}' but the heartbeat is ${age}h old (>= ${staleHours()}h). Reclaimable: heddle pr own claim ${pr}`, { verdict: 'STALE', pr: Number(pr), owner: marker.owner, ageHours: age });
      return result(3, `OWNED:${marker.owner} (fresh, heartbeat ${age}h ago) — STAND DOWN. Another instance is actively driving PR #${pr}. Do not push/merge/deepreview; coordinate with Maya if you think it should be yours.`, { verdict: 'OWNED', pr: Number(pr), owner: marker.owner, ageHours: age });
    }

    if (command === 'claim') {
      const now = nowIso();
      const latest = prComments(gh, pr!);
      let since = now;
      if (latest) {
        const { marker, id } = latest;
        const age = ageHours(marker.heartbeat);
        if (marker.owner !== me && marker.owner !== 'released' && age < staleHours()) {
          return { ...result(3, '', { verdict: 'REFUSED', pr: Number(pr), owner: marker.owner, ageHours: age }), error: `REFUSED — PR #${pr} is owned by '${marker.owner}' (fresh, ${age}h). STAND DOWN or coordinate with Maya.` };
        }
        if (marker.owner === me) since = marker.since;
        if (marker.owner === 'released') gh(['pr', 'comment', pr!, '--body', `♻️ Adopting PR #${pr} — released by its prior owner, now owned by '${me}'.`]);
        else if (marker.owner !== me) gh(['pr', 'comment', pr!, '--body', `♻️ Reclaiming PR #${pr} — prior owner '${marker.owner}' heartbeat was ${age}h stale (>= ${staleHours()}h). Now owned by '${me}'.`]);
        const nwo = gh(['repo', 'view', '--json', 'nameWithOwner']);
        const nameWithOwner = (JSON.parse(nwo) as { nameWithOwner?: string }).nameWithOwner;
        if (id && nameWithOwner) {
          try {
            gh(['api', `repos/${nameWithOwner}/issues/comments/${id}`, '-X', 'PATCH', '-f', `body=${markerBody(me, since, now)}`]);
            ensureLabel(gh); addLabel(gh, pr!);
            return result(0, `OK — PR #${pr} owned by '${me}' (heartbeat bumped ${now})`, { pr: Number(pr), owner: me, since, heartbeat: now });
          } catch { /* Fall through to a new marker, matching the shell helper. */ }
        }
      }
      ensureLabel(gh); addLabel(gh, pr!);
      gh(['pr', 'comment', pr!, '--body', markerBody(me, since, now)]);
      return result(0, `OK — PR #${pr} claimed by '${me}' (${now})`, { pr: Number(pr), owner: me, since, heartbeat: now });
    }

    if (command === 'release') {
      try { gh(['pr', 'edit', pr!, '--remove-label', LABEL]); } catch { /* A missing label does not block a handoff. */ }
      const now = nowIso();
      gh(['pr', 'comment', pr!, '--body', `${MARK_PREFIX} owner=released since=- heartbeat=${now} --> · '${me}' is releasing PR #${pr} — free for another instance to adopt (heddle pr own claim ${pr}).`]);
      return result(0, `OK — PR #${pr} released by '${me}'`, { pr: Number(pr), owner: me, heartbeat: now });
    }

    const listed = JSON.parse(gh(['pr', 'list', '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'number'])) as Array<{ number: number }>;
    const lines: string[] = [];
    for (const item of listed) {
      const latest = prComments(gh, String(item.number));
      if (latest?.marker.owner !== me) continue;
      const age = ageHours(latest.marker.heartbeat);
      lines.push(`#${item.number}  (heartbeat ${age}h ago)${age >= staleHours() ? `  ⚠️ heartbeat ${age}h STALE — bump or release` : ''}`);
    }
    return result(0, lines.join('\n'), { owner: me, prs: lines });
  } catch (err) {
    return failOpen(err instanceof Error ? err.message : String(err));
  }
}
