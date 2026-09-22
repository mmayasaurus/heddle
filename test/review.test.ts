import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffInstruction, embeddedDiff, pickReviewer, sameSnapshot, snapshotWorktree } from '../src/review.js';
import { loadRouting, resolveRoute } from '../src/routing.js';
import { mcpAttachable } from '../src/mcp.js';
import { useTempResources } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

describe('adversarial review helpers', () => {
  const { tempDir } = useTempResources('heddle-review-test-');

  it('selects the first different reviewer only when the author matches the primary provider', () => {
    const route = resolveRoute(loadRouting(), 'adversarial-review');
    expect(pickReviewer(route, undefined)).toBeNull();
    expect(pickReviewer(route, 'codex')).toBeNull();
    expect(pickReviewer(route, 'cursor')).toEqual({
      provider: 'codex', model: 'gpt-5.6-sol', reason: 'pool:2 (author is cursor)',
    });
  });

  it('treats native Gemini and OpenCode upstreams as their actual review family', () => {
    const geminiRoute = {
      taskClass: 'r', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview',
      editsCode: false, dispatchable: true, readOnly: true, autoAssess: false,
      reviewerPool: [
        { provider: 'gemini', model: 'gemini-3.1-pro-high' },
        { provider: 'opencode', model: 'opencode/nemotron-3-ultra-free' },
      ],
    } as any;
    expect(pickReviewer(geminiRoute, 'gemini', undefined, 'gemini-3.1-pro-high'))
      .toMatchObject({ provider: 'opencode', model: 'opencode/nemotron-3-ultra-free' });

    const claudeRoute = {
      ...geminiRoute, provider: 'opencode', model: 'anthropic/claude-opus-4-6',
      reviewerPool: [
        { provider: 'claude', model: 'opus' },
        { provider: 'codex', model: 'gpt-5.6-terra' },
      ],
    } as any;
    expect(pickReviewer(claudeRoute, 'claude', undefined, 'opus'))
      .toMatchObject({ provider: 'codex' });
  });

  it('rejects reviewer pools that contain no model family different from the author', () => {
    const path = join(tempDir(), 'routing.yaml');
    writeFileSync(path, `providers:\n  cursor: {}\ntask_classes:\n  only-author:\n    provider: cursor\n    model: m\n    reviewer_pool:\n      - { provider: cursor, model: m }\n  empty-pool:\n    provider: cursor\n    model: m\n`);
    const table = loadRouting(path);
    expect(() => pickReviewer(resolveRoute(table, 'only-author'), 'cursor')).toThrow(/must be a different model family/);
    expect(() => pickReviewer(resolveRoute(table, 'empty-pool'), 'cursor')).toThrow(/must be a different model family/);
  });

  it('skips a reviewer_pool entry the usable callback rejects — e.g. a held provider (qodo #63)', () => {
    const route = {
      taskClass: 'r', provider: 'codex', model: 'sol', editsCode: false, dispatchable: true,
      readOnly: false, autoAssess: false,
      reviewerPool: [{ provider: 'cursor', model: 'grok' }, { provider: 'gemini', model: 'pro' }],
    } as any;
    // author matches the primary (codex) → pick from the pool; cursor is unusable (held) → skip to gemini.
    const usable = (p: string) => (p === 'cursor' ? 'provider on hold and not routable yet' : null);
    expect(pickReviewer(route, 'codex', usable)?.provider).toBe('gemini');
    // when the ONLY different-family entry is unusable, there is no reviewer → throw (never dispatch it).
    const single = { ...route, reviewerPool: [{ provider: 'cursor', model: 'grok' }] } as any;
    expect(() => pickReviewer(single, 'codex', usable)).toThrow(/different model family/);
  });

  it('skips an mcp-incapable pool reviewer for an mcp-carrying class, picking the next capable one (HED-249 #73)', () => {
    // Mirrors dispatch's usable() gate: a picked reviewer inherits the class mcp, so a provider that
    // can't attach it (gemini) must be SKIPPED — pickReviewer selecting it would only hard-fail at
    // validateWorkerMcp. This covers a custom HEDDLE_ROUTING table (the shipped table's CI invariant
    // keeps gemini out of mcp pools; a custom one might not).
    const route = { taskClass: 'r', provider: 'cursor', model: 'grok', mcp: ['memtrace'],
      reviewerPool: [{ provider: 'cursor', model: 'grok' }, { provider: 'gemini', model: 'pro' }, { provider: 'codex', model: 'sol' }] } as any;
    const usable = (p: string) => ((route.mcp?.length ?? 0) > 0 && !mcpAttachable(p, route.mcp) ? 'cannot attach the class mcp' : null);
    // author=cursor (== primary) → pool pick: cursor is the author, gemini can't attach mcp → skip both → codex.
    expect(pickReviewer(route, 'cursor', usable)).toMatchObject({ provider: 'codex', model: 'sol' });
    // if the only mcp-capable different family is removed, there is no reviewer → refuse loudly.
    const noCapable = { ...route, reviewerPool: [{ provider: 'cursor', model: 'grok' }, { provider: 'gemini', model: 'pro' }] } as any;
    expect(() => pickReviewer(noCapable, 'cursor', usable)).toThrow(/different model family|cannot attach/);
  });

  it('reports a non-git directory as unavailable for a mandate comparison', () => {
    const snapshot = snapshotWorktree(tempDir());
    expect(snapshot).toEqual({ git: false, hash: null });
    expect(sameSnapshot(snapshot, snapshot)).toBeNull();
  });

  it('detects tracked, untracked, content, HEAD, and stash changes while excluding ignored files', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'tracked.txt'), 'base');
    git(cwd, 'add', 'tracked.txt');
    commit(cwd, 'init');

    const clean = snapshotWorktree(cwd);
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(true);

    const untracked = join(cwd, 'untracked.txt');
    writeFileSync(untracked, 'aaaa');
    const withUntracked = snapshotWorktree(cwd);
    expect(sameSnapshot(clean, withUntracked)).toBe(false);
    writeFileSync(untracked, 'bbbb'); // Same name and size: the mandate hashes content, not just paths.
    expect(sameSnapshot(withUntracked, snapshotWorktree(cwd))).toBe(false);
    rmSync(untracked);

    appendFileSync(join(cwd, 'tracked.txt'), ' changed');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(false);
    git(cwd, 'checkout', '--', 'tracked.txt');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(true);

    writeFileSync(join(cwd, 'head.txt'), 'new HEAD content');
    git(cwd, 'add', '-A');
    commit(cwd, 'head moved');
    expect(sameSnapshot(clean, snapshotWorktree(cwd))).toBe(false);
    const afterCommit = snapshotWorktree(cwd);
    appendFileSync(join(cwd, 'tracked.txt'), ' stash me');
    git(cwd, 'stash', 'push', '-q');
    expect(sameSnapshot(afterCommit, snapshotWorktree(cwd))).toBe(false);

    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
    git(cwd, 'add', '.gitignore');
    commit(cwd, 'ignore artifacts');
    const ignoredBase = snapshotWorktree(cwd);
    writeFileSync(join(cwd, 'ignored.txt'), 'outside mandate boundary');
    // Ignored build/tool artifacts are deliberately outside the read-only mandate boundary.
    expect(sameSnapshot(ignoredBase, snapshotWorktree(cwd))).toBe(true);

    expect(sameSnapshot(clean, { git: true, hash: null, error: 'boom' })).toBe(false);
    expect(sameSnapshot({ git: true, hash: null }, snapshotWorktree(cwd))).toBeNull();
  }, 90_000); // snapshot-heavy: ~6 REAL git spawns/call × ~10 calls; ~9s standalone but a loaded
  //            parallel-fork CI runner can exceed 45s (HED-211). It hangs on nothing — a generous
  //            ceiling beats a tight bound that intermittently reds CI; not masking a hang.

  it('normalizes provider casing on BOTH sides and skips unusable pool entries with a reasoned error', () => {
    const route = { taskClass: 'adversarial-review', provider: 'Cursor', model: 'cursor-grok-4.6-high',
      reviewerPool: [{ provider: ' Cursor ', model: 'cursor-grok-4.6-high' }, { provider: 'Gemini', model: 'gemini-3.1-pro-high' }, { provider: 'codex', model: 'gpt-5.6-sol' }] } as any;
    // YAML casing must not dodge the same-family guard: 'Cursor' route + 'cursor' author still matches,
    // the cased pool entry is still recognized as the author's family, and the pick is normalized.
    expect(pickReviewer(route, 'cursor')).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high', reason: 'pool:2 (author is cursor)' });
    // an unusable differing entry (excluded provider, unknown model) is skipped to the next one
    expect(pickReviewer(route, 'cursor', (p) => (p === 'gemini' ? 'provider excluded by policy' : null)))
      .toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', reason: 'pool:3 (author is cursor)' });
    // no usable different entry → the error names what was skipped and why
    expect(() => pickReviewer(route, 'cursor', () => 'provider excluded by policy')).toThrow(/skipped: gemini\/gemini-3.1-pro-high: provider excluded by policy/);
  });

  it('detects a bare git add and a mode-only chmod — index state and file modes are in the digest', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'tracked.txt'), 'body');
    git(cwd, 'add', 'tracked.txt');
    commit(cwd, 'init');
    writeFileSync(join(cwd, 'tracked.txt'), 'dirty');
    const base = snapshotWorktree(cwd);
    // staging the already-dirty file changes NO bytes and does not move HEAD — only the index
    git(cwd, 'add', 'tracked.txt');
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(false);
    git(cwd, 'reset', '-q'); // back to the baseline index
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(true);
    // a chmod changes no bytes either — the mode is part of each file line
    chmodSync(join(cwd, 'tracked.txt'), 0o755);
    expect(sameSnapshot(base, snapshotWorktree(cwd))).toBe(false);
  }, 90_000); // snapshot-heavy: ~6 REAL git spawns/call × ~10 calls; ~9s standalone but a loaded
  //            parallel-fork CI runner can exceed 45s (HED-211). It hangs on nothing — a generous
  //            ceiling beats a tight bound that intermittently reds CI; not masking a hang.

  it('excludes only untracked daemon churn under the top-level runtime prefixes, catching everything else (HED-550 round-3)', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'x.ts'), 'export const x = 1;\n');
    git(cwd, 'add', 'src/x.ts');
    commit(cwd, 'init');
    const writeAt = (rel: string, body: string) => {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), body);
    };

    // Daemon churn under the three top-level runtime dirs is excluded — the false positive HED-550 fixes.
    const baseline = snapshotWorktree(cwd);
    for (const rel of ['.memdb/daemon-state.json', '.memtrace/fts/index', '.serena/cache/typescript/sym.pkl']) {
      writeAt(rel, 'machine-local');
    }
    expect(sameSnapshot(baseline, snapshotWorktree(cwd))).toBe(true);

    // But a reviewer write OUTSIDE that narrow zone still flips the digest: a nested fake runtime dir
    // (round-2 was a silent write zone, F2) and serena AUTHORED content (only .serena/cache/ is daemon
    // churn — .serena/project.yml and .serena/memories/ are user/agent content, F1).
    for (const rel of ['src/.serena/cache/backdoor.ts', '.serena/project.yml', '.serena/memories/note.md']) {
      const prev = snapshotWorktree(cwd);
      writeAt(rel, 'reviewer write');
      expect(sameSnapshot(prev, snapshotWorktree(cwd))).toBe(false);
      rmSync(join(cwd, rel));
    }

    // .memtraceignore is tracked configuration, never a runtime artifact.
    writeFileSync(join(cwd, '.memtraceignore'), 'tracked configuration');
    expect(sameSnapshot(baseline, snapshotWorktree(cwd))).toBe(false);
  }, 90_000); // snapshot-heavy: ~10 snapshotWorktree calls, each several REAL git spawns; a loaded
  //            parallel-fork run can exceed the default 30s (HED-211). Generous ceiling, not a hang.

  it('excludes only untracked Verity runtime writes; any other .verity/ name, and a tracked one, still flips the digest (HED-699)', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'x.ts'), 'export const x = 1;\n');
    mkdirSync(join(cwd, '.verity'));
    writeFileSync(join(cwd, '.verity', '.seeded'), 'tracked on purpose\n');
    git(cwd, 'add', 'src/x.ts', '.verity/.seeded');
    commit(cwd, 'init');
    const writeAt = (rel: string, body: string) => {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), body);
    };

    // What Verity's hooks write inside a worker (ledger 2237) is not a reviewer write.
    const baseline = snapshotWorktree(cwd);
    for (const rel of ['.verity/.conversation-buffer', '.verity/.logs/cli.log', '.verity/.last-analysis.ce78350b6387',
      '.verity/.task-context/352c013d-5d3e-459c-b5cb-dee8684240ee.jsonl', '.verity/.snapshot/src/x.ts']) {
      writeAt(rel, 'verity runtime');
    }
    expect(sameSnapshot(baseline, snapshotWorktree(cwd))).toBe(true);

    // A name Verity never writes, the knowledge graph and visible config all flip it (round-2 finding 4).
    for (const rel of ['.verity/.exfil', '.verity/.logs/payload.ts', '.verity/memory/evil.md', '.verity/config.json']) {
      const prev = snapshotWorktree(cwd);
      writeAt(rel, 'reviewer write');
      expect(sameSnapshot(prev, snapshotWorktree(cwd)), rel).toBe(false);
      rmSync(join(cwd, rel));
    }

    // A TRACKED runtime-named file is project content: an edit is always hashed.
    const beforeEdit = snapshotWorktree(cwd);
    writeFileSync(join(cwd, '.verity', '.seeded'), 'edited\n');
    expect(sameSnapshot(beforeEdit, snapshotWorktree(cwd))).toBe(false);
  }, 90_000); // snapshot-heavy (HED-211): ~8 snapshotWorktree calls of several REAL git spawns each.

  it('still hashes a TRACKED file under a runtime dir, and excludes only untracked .serena/cache churn (HED-550)', () => {
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    mkdirSync(join(cwd, '.serena'));
    writeFileSync(join(cwd, '.serena', 'project.yml'), 'name: proj\n');
    git(cwd, 'add', '.serena/project.yml');
    commit(cwd, 'init');

    const baseline = snapshotWorktree(cwd);
    // .serena/project.yml is authored config, not daemon cache — an edit is ALWAYS hashed (tracked or
    // not), so a reviewer cannot change committed serena config unseen (qodo #1 / round-3 F1).
    writeFileSync(join(cwd, '.serena', 'project.yml'), 'name: proj-edited\n');
    expect(sameSnapshot(baseline, snapshotWorktree(cwd))).toBe(false);

    // An untracked daemon cache write under .serena/cache/ stays excluded.
    const withEdit = snapshotWorktree(cwd);
    mkdirSync(join(cwd, '.serena', 'cache'), { recursive: true });
    writeFileSync(join(cwd, '.serena', 'cache', 'symbols.pkl'), 'machine-local');
    expect(sameSnapshot(withEdit, snapshotWorktree(cwd))).toBe(true);
  }, 90_000); // snapshot-heavy (HED-211): generous ceiling under parallel-fork load, not a hang.

  it('does NOT see a reviewer write to a gitignored .serena/ path — the pre-existing ignored-path boundary (HED-569)', () => {
    // Boundary DOC, not a HED-550 regression: snapshotWorktree enumerates via
    // `git ls-files --others --exclude-standard`, which omits gitignored paths — so in a repo that
    // gitignores .serena/ (heddle itself does), a reviewer write_memory to .serena/memories/x, or an
    // edit to .serena/project.yml, is invisible to the mandate digest before isToolRuntimePath is ever
    // consulted. Same boundary the mandate already accepts for node_modules/, dist/, .env. Whether to
    // enumerate authored tool-runtime paths even when ignored is HED-569; this pins current behavior so
    // any future change is deliberate. (Round-2 code had the identical property — the gap predates 550.)
    const cwd = tempDir();
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, '.gitignore'), '.serena/\n');
    git(cwd, 'add', '.gitignore');
    commit(cwd, 'gitignore serena');

    const baseline = snapshotWorktree(cwd);
    mkdirSync(join(cwd, '.serena', 'memories'), { recursive: true });
    writeFileSync(join(cwd, '.serena', 'memories', 'note.md'), 'reviewer write_memory');
    writeFileSync(join(cwd, '.serena', 'project.yml'), 'name: proj\n');
    // Both writes sit under a gitignored dir → outside the enumeration → digest unchanged.
    expect(sameSnapshot(baseline, snapshotWorktree(cwd))).toBe(true);
  });

  it('prepends an actionable diff instruction and leaves a blank line before the task', () => {
    const instruction = diffInstruction('main');
    expect(instruction).toContain('git diff main...HEAD');
    expect(instruction).toContain('git log main..HEAD --oneline');
    expect(instruction.endsWith('\n\n')).toBe(true);
  });

  it('gives a tool-less reviewer a truthful no-diff message (not an unrunnable git command) when git fails', () => {
    // codeant PR #138: when git fails (bad ref / not a repo) embeddedDiff must NOT fall back to the
    // "run `git diff`" instruction for a tool-less HTTP reviewer that cannot execute it.
    const cwd = tempDir(); // not a git repo → embeddedDiff's git calls throw → catch-block fallback
    const toolless = embeddedDiff(cwd, 'main', undefined, false);
    expect(toolless).not.toBe(diffInstruction('main'));
    expect(toolless).not.toContain('run `git diff');
    expect(toolless).toContain('cannot see the changes');
    expect(toolless.endsWith('\n\n')).toBe(true);
    // the file-tool variant (claude read-only) is unchanged — it keeps the run-it-yourself instruction
    expect(embeddedDiff(cwd, 'main', undefined, true)).toBe(diffInstruction('main'));
  });
});
