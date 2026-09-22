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

// HED-699: Verity's hooks run inside every headless Claude worker and write machine-local state under
// `.verity/` (ledger 2237: `.conversation-buffer` + `.logs/cli.log` quarantined a review whose worker had
// NO write tools). Only the names Verity's CLI writes are churn (round-2 review finding 4).
describe('isToolRuntimePath — Verity hook runtime (HED-699)', () => {
  it('matches exactly the state files, logs, task context, pending cache and mirror dirs Verity writes', () => {
    for (const rel of [
      '.verity/.conversation-buffer', '.verity/.iteration-count', '.verity/.last-reviewed-sha', '.verity/.last-intent',
      '.verity/.seeded', '.verity/.plugin-active', '.verity/.memory-sync-state.json',
      '.verity/.last-analysis', '.verity/.last-analysis.ce78350b6387', '.verity/.last-pass-hash.3113977d2a16',
      '.verity/.advisory-episode.ce78350b6387', '.verity/.ignore-declaration.9be0ad484d2f',
      '.verity/.task-context/352c013d-5d3e-459c-b5cb-dee8684240ee.jsonl',
      '.verity/.cache/pending-1790036195-642b98f2.json',
      '.verity/.logs/cli.log', '.verity/.logs/stderr.log', '.verity/.logs/cli.log.1',
      '.verity/.snapshot/.heddle/launch-nostepinne.sh', '.verity/.baseline/96c7c2693edf9af1/files/src/x.ts', '.verity/.baseline/.carry',
    ]) expect(isToolRuntimePath(rel), rel).toBe(true);
  });

  it('does NOT match names Verity never writes, the knowledge graph, config, credentials or lookalikes', () => {
    for (const rel of [
      '.verity/.exfil', '.verity/.logs/payload.ts', '.verity/.logs/cli.log.2', '.verity/.cache/stolen.json',
      '.verity/.task-context/notes.txt', '.verity/.task-context/nested/x.jsonl', '.verity/.last-analysis.not-hex',
      '.verity/.snapshot', '.verity/.baseline',
      '.verity/memory/index.md', '.verity/memory/.hidden-note', '.verity/config.json', '.verity/standard.yaml', '.verity/credentials',
      '.verity', 'src/.verity/.conversation-buffer', '.verityx/.conversation-buffer',
    ]) expect(isToolRuntimePath(rel), rel).toBe(false);
  });
});
