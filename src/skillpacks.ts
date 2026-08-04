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

export function readPack(name: string): string {
  const p = join(packsDir(), `${name}.md`);
  if (!existsSync(p)) {
    throw new Error(`skill pack "${name}" not found (looked in ${packsDir()})`);
  }
  return readFileSync(p, 'utf8').trim();
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
