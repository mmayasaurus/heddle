import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const BEGIN = '<!-- heddle:begin -->';
const END = '<!-- heddle:end -->';

/**
 * Compose packs into an AGENTS.md section in `cwd`, preserving any existing human-authored
 * content outside heddle's markers. Returns a restore function that puts the file back exactly
 * as it was — dispatch always restores, so a worktree is never left mutated by orchestration.
 */
export function materializeAgentsMd(cwd: string, packNames: string[]): () => void {
  const target = join(cwd, 'AGENTS.md');
  const existed = existsSync(target);
  const original = existed ? readFileSync(target, 'utf8') : null;

  if (packNames.length === 0) return () => { /* nothing written */ };

  const body = packNames.map((n) => `### ${n}\n\n${readPack(n)}`).join('\n\n---\n\n');
  const block = `${BEGIN}\n<!-- Task-scoped instructions written by heddle. Restored after dispatch. -->\n\n${body}\n${END}`;

  let next: string;
  if (original === null) {
    next = `${block}\n`;
  } else if (original.includes(BEGIN) && original.includes(END)) {
    next = original.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  } else {
    next = `${original.trimEnd()}\n\n${block}\n`;
  }

  writeFileSync(target, next, 'utf8');

  return () => {
    if (original !== null) {
      writeFileSync(target, original, 'utf8');
      return;
    }
    // We created this file. Remove it only if it is still byte-identical to what we wrote —
    // if anything (a human, the worker) touched it since, leave it alone rather than discard
    // work we didn't author.
    try {
      if (readFileSync(target, 'utf8') === next) unlinkSync(target);
    } catch { /* already gone, or unreadable — leave it */ }
  };
}
