import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePreset } from '../src/wizard/presets.js';
import { useTempResources } from './helpers.js';

const presetRuleIds = [
  'no-rm-recursive-force',
  'no-git-history-rewrite',
  'no-git-worktree-discard',
  'no-destructive-sql',
  'pr-flow-reminder',
];

function seedCatalog(root: string, ids = presetRuleIds): void {
  mkdirSync(root, { recursive: true });
  for (const id of ids) {
    writeFileSync(join(root, `${id}.yaml`), `id: ${id}\nevent: PreToolUse\nmatch: {}\naction: nudge\nenforce: false\nsubagent_aware: false\nmessage: ${id}\nfail_open: true\n`);
  }
}

describe('resolvePreset', () => {
  const { tempDir } = useTempResources('heddle-presets-test-');

  it.each([
    ['minimal', ['no-rm-recursive-force']],
    ['standard', ['no-rm-recursive-force', 'no-git-history-rewrite', 'no-git-worktree-discard', 'pr-flow-reminder']],
    ['strict', ['no-rm-recursive-force', 'no-git-history-rewrite', 'no-git-worktree-discard', 'no-destructive-sql', 'pr-flow-reminder']],
  ] as const)('returns the stable, unenforced %s tier', (tier, ids) => {
    const root = tempDir();
    seedCatalog(root);

    expect(resolvePreset(tier, root)).toEqual(ids.map((id) => ({ id, enforce: false })));
  });

  it('rejects an unknown tier', () => {
    expect(() => resolvePreset('unsafe' as never, tempDir())).toThrow("unknown safety preset 'unsafe'");
  });

  it('lists catalog ids missing from the requested tier', () => {
    const root = tempDir();
    seedCatalog(root, presetRuleIds.filter((id) => id !== 'no-destructive-sql'));

    expect(() => resolvePreset('strict', root)).toThrow('no-destructive-sql');
  });
});
