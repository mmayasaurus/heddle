import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules } from '../../src/rules/load.js';
import { useTempResources } from '../helpers.js';

const yaml = (id: string) => `id: ${id}\nevent: SessionStart\nmatch: {}\naction: inject\nenforce: false\nsubagent_aware: false\nmessage: hello\nfail_open: true\n`;

describe('rule loader', () => {
  const { tempDir } = useTempResources('heddle-rules-load-');
  it('loads good direct yaml files while reporting bad files', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'alpha.yaml'), yaml('alpha')); writeFileSync(join(dir, 'beta.yaml'), yaml('beta')); writeFileSync(join(dir, 'bad.yaml'), 'id: [');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(loadRules(dir).map((r) => r.id)).toEqual(['alpha', 'beta']);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("rule 'bad.yaml' ignored"));
    stderr.mockRestore();
  });
  it('skips a rule whose id differs from its filename stem', () => {
    const dir = tempDir(); writeFileSync(join(dir, 'alpha.yaml'), yaml('not-alpha'));
    expect(loadRules(dir)).toEqual([]);
  });
  it('never loads proposed rules', () => {
    const dir = tempDir(); mkdirSync(join(dir, 'proposed')); writeFileSync(join(dir, 'proposed', 'would-match.yaml'), yaml('would-match'));
    expect(loadRules(dir)).toEqual([]);
  });
  it('fails open for a nonexistent directory', () => expect(loadRules(join(tempDir(), 'missing'))).toEqual([]));
});
