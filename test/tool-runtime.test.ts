import { describe, expect, it } from 'vitest';
import { isToolRuntimePath } from '../src/tool-runtime.js';

// Direct regression pin for the exclusion predicate the read-only mandate (review.ts) and the
// parent-escape fingerprint (worktree.ts) both key on. HED-550 round-3 narrowed it from an
// any-segment match to a top-level daemon-prefix match; each case below is a finding that match
// closed (F1/F2/F4) or the false positive it must still fix.
describe('isToolRuntimePath', () => {
  it('matches daemon churn under the three top-level runtime prefixes (the false positive HED-550 fixes)', () => {
    expect(isToolRuntimePath('.memdb/daemon-state.json')).toBe(true);
    expect(isToolRuntimePath('.memdb/graph-cache/x')).toBe(true);
    expect(isToolRuntimePath('.memtrace/fts/index')).toBe(true);
    expect(isToolRuntimePath('.serena/cache/typescript/symbols.pkl')).toBe(true);
  });

  it('does NOT match a nested fake runtime dir — it was a silent write zone in round-2 (F2)', () => {
    expect(isToolRuntimePath('src/.serena/cache/backdoor.ts')).toBe(false);
    expect(isToolRuntimePath('pkg/.memdb/evil')).toBe(false);
    expect(isToolRuntimePath('a/b/.memtrace/x')).toBe(false);
  });

  it('does NOT match a bare file named like a runtime dir, nor a longer sibling (F4)', () => {
    expect(isToolRuntimePath('.serena')).toBe(false);
    expect(isToolRuntimePath('.memdb')).toBe(false);
    expect(isToolRuntimePath('.memtrace')).toBe(false);
    expect(isToolRuntimePath('.memdbextra/x')).toBe(false);
    expect(isToolRuntimePath('.serenax/cache/x')).toBe(false);
  });

  it('does NOT match serena agent/user-authored content — only .serena/cache/ is daemon (F1)', () => {
    // project.yml + memories/ are authored; write_memory is a reviewer-callable serena tool.
    expect(isToolRuntimePath('.serena/project.yml')).toBe(false);
    expect(isToolRuntimePath('.serena/project.local.yml')).toBe(false);
    expect(isToolRuntimePath('.serena/memories/note.md')).toBe(false);
    expect(isToolRuntimePath('.serena/.gitignore')).toBe(false);
    // a bare file at `.serena/cache` (no child) is not the cache DIR's churn
    expect(isToolRuntimePath('.serena/cache')).toBe(false);
  });

  it('does NOT match ordinary source or the tracked .memtraceignore config', () => {
    expect(isToolRuntimePath('src/review.ts')).toBe(false);
    expect(isToolRuntimePath('.memtraceignore')).toBe(false);
    expect(isToolRuntimePath('README.md')).toBe(false);
  });
});

// HED-699: Verity's hooks run inside every headless Claude worker and rewrite hidden runtime files
// directly under `.verity/` (ledger 2237: `.conversation-buffer` + `.logs/cli.log` quarantined a
// review whose worker had NO write tools). Only that hidden runtime layer is churn.
describe('isToolRuntimePath — Verity hook runtime (HED-699)', () => {
  it('matches the hidden runtime files directly under .verity/ and anything under .verity/.logs/', () => {
    expect(isToolRuntimePath('.verity/.conversation-buffer')).toBe(true);
    expect(isToolRuntimePath('.verity/.last-analysis.ce78350b6387')).toBe(true);
    expect(isToolRuntimePath('.verity/.iteration-count')).toBe(true);
    expect(isToolRuntimePath('.verity/.logs/cli.log')).toBe(true);
    expect(isToolRuntimePath('.verity/.logs/stderr.log')).toBe(true);
  });

  it('does NOT match the knowledge graph, visible config, nested hidden files or a lookalike dir', () => {
    expect(isToolRuntimePath('.verity/memory/index.md')).toBe(false);
    expect(isToolRuntimePath('.verity/memory/.hidden-note')).toBe(false);
    expect(isToolRuntimePath('.verity/config.json')).toBe(false);
    expect(isToolRuntimePath('.verity')).toBe(false);
    expect(isToolRuntimePath('src/.verity/.conversation-buffer')).toBe(false);
    expect(isToolRuntimePath('.verityx/.conversation-buffer')).toBe(false);
  });
});
