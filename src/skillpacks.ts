import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withFileLock } from './matlock.js';

/**
 * Skill-pack materializer.
 *
 * A "skill pack" is a markdown instruction bundle. Each CLI auto-loads instructions its own way,
 * so heddle composes the requested packs and writes them where the target worker will actually
 * read them:
 *   - Codex / agy / Cursor → AGENTS.md at the worktree root (all three auto-load it; Cursor also
 *     reads CLAUDE.md and .cursor/rules).
 *   - Claude → not a file; packs map onto agent-definition frontmatter (`skills:`), handled by
 *     the orchestrator, not here.
 *
 * Lean by default: measured auto-load overhead is real (~22k input tokens/invocation on a fully
 * loaded global Codex config, ~18k on agy), so packs attach only what a task needs.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function packsDir(): string {
  return process.env.HEDDLE_PACKS ?? join(here, '..', 'skills');
}

export function listPacks(): string[] {
  const dir = packsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
}

/**
 * Packs EVERY delegated worker gets, no matter what the routing table or the caller lists.
 * `worker-role` is governance, not task fit: the first real pilot dispatch (2026-08-10) had a codex
 * worker inherit the fleet's claim-before-code policy and refuse to work ("which agent am I?");
 * without it a worker may also claim issues / own PRs it must not. Decided 2026-08-15 (Maya via
 * Agent R): an explicit `skills` list ADDS to policy, it never removes worker-role.
 */
export const MANDATORY_PACKS = ['worker-role'] as const;

/**
 * The dispatcher's union rule: mandatory packs first, then the requested packs in their given
 * order, de-duplicated. Applied to BOTH the task-class defaults and a caller's explicit list, on
 * both the task-class and direct provider/model paths — so what the ledger records as `skills` is
 * exactly what was materialized.
 */
export function withMandatoryPacks(skills: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of [...MANDATORY_PACKS, ...(skills ?? [])]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function readPack(name: string): string {
  const p = join(packsDir(), `${name}.md`);
  if (!existsSync(p)) {
    throw new Error(`skill pack "${name}" not found (looked in ${packsDir()})`);
  }
  return readFileSync(p, 'utf8').trim();
}

/**
 * The packs as one text block — for CLIs that take instructions on the command line instead of a
 * file (claude `--append-system-prompt`). Same content the AGENTS.md block carries.
 */
export function composePacks(packNames: readonly string[]): string {
  return packNames.map((n) => `### ${n}\n\n${readPack(n)}`).join('\n\n---\n\n');
}

/**
 * Per-dispatch marker pair. The id makes concurrent dispatches into ONE cwd (the normal case,
 * SPEC §5) safe: each dispatch appends, replaces, and removes ONLY its own block (HED-56 — the
 * id-less predecessor raced: dispatch B captured A's block as its "original" and restored it
 * forever, while worker A read B's packs).
 */
const beginMarker = (id: string): string => `<!-- heddle:begin id=${id} -->`;
const endMarker = (id: string): string => `<!-- heddle:end id=${id} -->`;
/** Any heddle block, old id-less format included — used only to recognize heddle-authored spans. */
const ANY_BLOCK = /[ \t]*<!-- heddle:begin( id=([A-Za-z0-9._-]+))? -->[\s\S]*?<!-- heddle:end(?: id=\2)? -->\n?/g;

export interface MaterializeOpts {
  /** Unique per dispatch (the ledger row id). Distinct concurrent dispatches MUST differ. */
  dispatchId: string | number;
  /**
   * Liveness oracle for OTHER dispatches' blocks (ledger in-flight check). A block whose id is not
   * live belongs to a crashed dispatch — it is garbage-collected on the next materialization into
   * that cwd, which also self-heals blocks left by the old id-less format (id undefined → dead).
   */
  isLive?: (dispatchId: string) => boolean;
}

function stripDeadBlocks(content: string, ownId: string, isLive?: (id: string) => boolean): string {
  return content.replace(ANY_BLOCK, (whole, _g1, id?: string) => {
    if (id === ownId) return ''; // a same-id leftover (crashed retry) is always replaced
    if (id && isLive?.(id)) return whole; // a LIVE peer's block stays untouched
    if (id && !isLive) return whole; // no oracle → never GC a peer (only own/legacy)
    return ''; // dead peer, or legacy id-less block: heddle-authored garbage, collect it
  });
}

/**
 * Compose packs into a per-dispatch AGENTS.md block in `cwd`, preserving existing human-authored
 * content AND other live dispatches' blocks. Returns a restore function that removes exactly this
 * dispatch's insertion: the file ends byte-identical for the surviving content whatever order
 * overlapping dispatches finish in, and is deleted only when nothing but whitespace remains.
 */
export function materializeAgentsMd(cwd: string, packNames: string[], opts: MaterializeOpts): () => void {
  const target = join(cwd, 'AGENTS.md');
  if (packNames.length === 0) return () => { /* nothing written */ };
  const ownId = String(opts.dispatchId);

  const body = packNames.map((n) => `### ${n}\n\n${readPack(n)}`).join('\n\n---\n\n');
  const block = `${beginMarker(ownId)}\n<!-- Task-scoped instructions for heddle dispatch #${ownId}. Written by heddle; removed when that dispatch ends. If you are a worker for a DIFFERENT dispatch id, follow your own block only. -->\n\n${body}\n${endMarker(ownId)}`;

  let inserted = '';
  withFileLock(join(cwd, '.heddle-agents.lock'), () => {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const base = current === null ? null : stripDeadBlocks(current, ownId, opts.isLive);
    if (base === null || base.trim() === '') {
      inserted = `${block}\n`;
      writeFileSync(target, inserted, 'utf8');
    } else {
      inserted = `${base.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
      writeFileSync(target, base + inserted, 'utf8');
    }
  });

  return () => {
    withFileLock(join(cwd, '.heddle-agents.lock'), () => {
      // Remove exactly what THIS dispatch inserted (other blocks may sit before/after it).
      // If the exact insertion is gone (a human or the worker edited inside it), fall back to
      // removing the marker-delimited span; if even the markers are gone, leave the file alone.
      try {
        const current = readFileSync(target, 'utf8');
        let next = current.includes(inserted)
          ? current.replace(inserted, '')
          : current.replace(new RegExp(`\\n*[ \\t]*${beginMarker(ownId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker(ownId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`), '\n');
        if (next === current) return; // our block is gone entirely — nothing of ours to remove
        if (next.trim() === '') unlinkSync(target);
        else writeFileSync(target, next, 'utf8');
      } catch { /* already gone, or unreadable — leave it */ }
    });
  };
}
