import { describe, it, expect } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { materializeAgentsMd } from '../src/skillpacks.js';
import { materializeWorkerMcp } from '../src/mcp.js';
import { withFileLock } from '../src/matlock.js';
import { dispatch } from '../src/dispatch.js';
import { Ledger } from '../src/ledger.js';
import { sameSnapshot, snapshotWorktree } from '../src/review.js';
import { IDENTITIES, useTempResources } from './helpers.js';
import type { WorkerAdapter } from '../src/types.js';

describe('concurrent materialization', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-materialize-concurrent-');

  function installPacks(): () => void {
    const packs = tempDir();
    writeFileSync(join(packs, 'alpha.md'), 'ALPHA-CONTENT');
    writeFileSync(join(packs, 'beta.md'), 'BETA-CONTENT');
    writeFileSync(join(packs, 'worker-role.md'), 'WORKER-ROLE-CONTENT');
    const prior = process.env.HEDDLE_PACKS;
    process.env.HEDDLE_PACKS = packs;
    return () => {
      if (prior === undefined) delete process.env.HEDDLE_PACKS;
      else process.env.HEDDLE_PACKS = prior;
    };
  }

  function agents(cwd: string): string {
    return readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  }

  it('keeps both dispatch blocks in insertion order and removes each independently when A finishes before B', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      const restoreA = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      const restoreB = materializeAgentsMd(cwd, ['beta'], { dispatchId: 2 });
      expect(agents(cwd)).toContain('ALPHA-CONTENT');
      expect(agents(cwd)).toContain('BETA-CONTENT');
      expect(agents(cwd).indexOf('id=1')).toBeLessThan(agents(cwd).indexOf('id=2'));

      restoreA();
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
      expect(agents(cwd)).toContain('id=2');
      expect(agents(cwd)).toContain('BETA-CONTENT');
      expect(agents(cwd)).not.toContain('id=1');
      expect(agents(cwd)).not.toContain('ALPHA-CONTENT');

      restoreB();
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    } finally { restoreEnv(); }
  });

  it('removes every heddle byte when B finishes before A after overlapping materializations', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      const restoreA = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      const restoreB = materializeAgentsMd(cwd, ['beta'], { dispatchId: 2 });
      restoreB();
      restoreA();
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(cwd, 'AGENTS.md')) ? agents(cwd) : '').not.toContain('<!-- heddle');
    } finally { restoreEnv(); }
  });

  it('preserves pre-existing human content byte-identically after overlapping dispatches finish in either order', () => {
    const restoreEnv = installPacks();
    try {
      for (const order of ['fifo', 'lifo'] as const) {
        const cwd = tempDir();
        writeFileSync(join(cwd, 'AGENTS.md'), 'human text\n');
        const restoreA = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
        const restoreB = materializeAgentsMd(cwd, ['beta'], { dispatchId: 2 });
        expect(agents(cwd).startsWith('human text')).toBe(true);
        expect(agents(cwd)).toContain('ALPHA-CONTENT');
        expect(agents(cwd)).toContain('BETA-CONTENT');
        if (order === 'fifo') { restoreA(); restoreB(); } else { restoreB(); restoreA(); }
        expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('human text\n');
      }
    } finally { restoreEnv(); }
  });

  it('restores human content without adding a trailing newline when a lone dispatch finishes', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      writeFileSync(join(cwd, 'AGENTS.md'), 'no newline at end');
      const restore = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      restore();
      expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('no newline at end');
    } finally { restoreEnv(); }
  });

  it('replaces a same-id crashed retry block instead of duplicating it and lets the later restore remove it', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      materializeAgentsMd(cwd, ['alpha'], { dispatchId: 7 });
      const restore = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 7 });
      expect((agents(cwd).match(/heddle:begin id=7/g) ?? [])).toHaveLength(1);
      restore();
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    } finally { restoreEnv(); }
  });

  it('garbage-collects dead blocks only with a liveness oracle while retaining peers without one', () => {
    const restoreEnv = installPacks();
    try {
      const deadCwd = tempDir();
      materializeAgentsMd(deadCwd, ['alpha'], { dispatchId: 1 });
      materializeAgentsMd(deadCwd, ['beta'], { dispatchId: 2, isLive: (id) => id === '2' });
      expect(agents(deadCwd)).not.toContain('id=1');
      expect(agents(deadCwd)).toContain('id=2');

      const peerCwd = tempDir();
      materializeAgentsMd(peerCwd, ['alpha'], { dispatchId: 1 });
      materializeAgentsMd(peerCwd, ['beta'], { dispatchId: 2 });
      expect(agents(peerCwd)).toContain('id=1');
      expect(agents(peerCwd)).toContain('id=2');
    } finally { restoreEnv(); }
  });

  it('collects legacy id-less blocks while retaining the surrounding human content', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      writeFileSync(join(cwd, 'AGENTS.md'), 'human\n\n<!-- heddle:begin -->\nold stale block\n<!-- heddle:end -->\n');
      const restore = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 3, isLive: () => true });
      expect(agents(cwd)).not.toContain('old stale block');
      expect(agents(cwd)).toContain('human');
      expect(agents(cwd)).toContain('id=3');
      restore();
      expect(agents(cwd).trim()).toBe('human');
      expect(agents(cwd)).not.toContain('heddle');
    } finally { restoreEnv(); }
  });

  it('gives each overlapping worker a block whose mandate header and packs belong only to that dispatch', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      materializeAgentsMd(cwd, ['beta'], { dispatchId: 2 });
      const content = agents(cwd);
      expect(content).toContain('heddle dispatch #1');
      expect(content).toContain('heddle dispatch #2');
      const ownBlock = content.slice(content.indexOf('<!-- heddle:begin id=1 -->'), content.indexOf('<!-- heddle:end id=1 -->'));
      expect(ownBlock).toContain('ALPHA-CONTENT');
      expect(ownBlock).not.toContain('BETA-CONTENT');
    } finally { restoreEnv(); }
  });

  it('keeps cursor MCP configuration attached until the last overlapping reference finishes in FIFO and LIFO order', () => {
    for (const order of ['fifo', 'lifo'] as const) {
      const cwd = tempDir();
      const restore1 = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 });
      const restore2 = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 2 });
      const path = join(cwd, '.cursor', 'mcp.json');
      const sidecar = join(cwd, '.cursor', '.heddle-mcp-refs.json');
      expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.memtrace).toBeDefined();
      expect(Object.keys(JSON.parse(readFileSync(sidecar, 'utf8')).refs)).toEqual(['1', '2']);
      if (order === 'fifo') { restore1(); } else { restore2(); }
      expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.memtrace).toBeDefined();
      expect(Object.keys(JSON.parse(readFileSync(sidecar, 'utf8')).refs)).toEqual(order === 'fifo' ? ['2'] : ['1']);
      if (order === 'fifo') { restore2(); } else { restore1(); }
      expect(existsSync(path)).toBe(false);
      expect(existsSync(sidecar)).toBe(false);
    }
  });

  it('restores a pre-existing cursor MCP file byte-identically after overlapping references finish in either order', () => {
    const original = '{"mcpServers":{"mine":{"command":"x","args":[]}}}';
    for (const order of ['fifo', 'lifo'] as const) {
      const cwd = tempDir();
      const cursorDir = join(cwd, '.cursor');
      mkdirSync(cursorDir);
      const path = join(cursorDir, 'mcp.json');
      writeFileSync(path, original);
      const restore1 = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 });
      const restore2 = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 2 });
      const live = JSON.parse(readFileSync(path, 'utf8')).mcpServers;
      expect(live.mine).toBeDefined();
      expect(live.memtrace).toBeDefined();
      if (order === 'fifo') { restore1(); restore2(); } else { restore2(); restore1(); }
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(existsSync(join(cursorDir, '.heddle-mcp-refs.json'))).toBe(false);
    }
  });

  it('garbage-collects dead cursor MCP references when the next attach provides a liveness oracle', () => {
    const cwd = tempDir();
    materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 });
    materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 2, isLive: (id) => id === '2' });
    const refs = JSON.parse(readFileSync(join(cwd, '.cursor', '.heddle-mcp-refs.json'), 'utf8')).refs;
    expect(refs).toHaveProperty('2');
    expect(refs).not.toHaveProperty('1');
  });

  it('runs locked mutations, breaks stale locks, and proceeds unlocked when the lock parent does not exist', () => {
    const cwd = tempDir();
    const lock = join(cwd, '.lock');
    expect(withFileLock(lock, () => 'value')).toBe('value');
    mkdirSync(lock);
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    let staleRan = false;
    withFileLock(lock, () => { staleRan = true; });
    expect(staleRan).toBe(true);
    let missingParentRan = false;
    expect(() => withFileLock(join(cwd, 'missing', '.lock'), () => { missingParentRan = true; })).not.toThrow();
    expect(missingParentRan).toBe(true);
  });

  it('keeps both real dispatch mandates visible to a nested cursor worker and restores AGENTS.md after the outer dispatch', async () => {
    const restorePacks = installPacks();
    const cwd = tempDir();
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, [
      'providers:', '  cursor:', '    execution: headless',
      'task_classes:', '  mat:', '    provider: cursor', '    model: cursor-grok-4.6-high', '    skills: [alpha]',
    ].join('\n'));
    const priorRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = routing;
    try {
      const ledger = tempLedger();
      let innerAgents = '';
      let calls = 0;
      const adapter: WorkerAdapter = {
        name: 'fake', provider: 'cursor',
        dispatch: async () => {
          calls += 1;
          if (calls === 1) {
            await dispatch(
              { taskClass: 'mat', prompt: 'inner', cwd, skills: ['beta'], identity: IDENTITIES.unbound },
              ledger, () => adapter,
            );
          } else {
            innerAgents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
          }
          return { ok: true, output: 'done', exitCode: 0 };
        },
      };
      await dispatch({ taskClass: 'mat', prompt: 'outer', cwd, identity: IDENTITIES.unbound }, ledger, () => adapter);
      expect(innerAgents).toContain('ALPHA-CONTENT');
      expect(innerAgents).toContain('BETA-CONTENT');
      expect((innerAgents.match(/heddle dispatch #/g) ?? [])).toHaveLength(2);
      expect(ledger.recent(2).map((row) => row.skills).sort()).toEqual(['worker-role,alpha', 'worker-role,beta']);
      expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    } finally {
      if (priorRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = priorRouting;
      restorePacks();
    }
  });

  it('preserves a pre-existing whitespace-only AGENTS.md byte-identically after its materialized block restores', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      const path = join(cwd, 'AGENTS.md');
      writeFileSync(path, '  \n\n');
      const restore = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      expect(agents(cwd)).toBe(`  \n\n\n<!-- heddle:begin id=1 -->\n<!-- Task-scoped instructions for heddle dispatch #1. Written by heddle; removed when that dispatch ends. If you are a worker for a DIFFERENT dispatch id, follow your own block only. -->\n\n### alpha\n\nALPHA-CONTENT\n<!-- heddle:end id=1 -->\n`);
      restore();
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('  \n\n');
    } finally { restoreEnv(); }
  });

  it('leaves an own AGENTS.md block with an edited interior byte fully in place during restore', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      const path = join(cwd, 'AGENTS.md');
      const restore = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 1 });
      writeFileSync(path, readFileSync(path, 'utf8').replace('Task-scoped', 'Task-scoped INTRUDER'));
      restore();
      const content = readFileSync(path, 'utf8');
      expect(existsSync(path)).toBe(true);
      expect(content).toContain('INTRUDER');
      expect(content).toContain('<!-- heddle:begin id=1 -->');
      expect(content).toContain('<!-- heddle:end id=1 -->');
    } finally { restoreEnv(); }
  });

  it('treats an unfinished ledger row past its stale window as dead to the liveness oracle', () => {
    const ledger = tempLedger();
    const id = ledger.start({
      orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
      skills: 'worker-role', issue: 'HED-78', pr: null, cwd: '/tmp/x', promptPreview: 'in flight',
      sessionId: null, fellBackFrom: null,
    });
    expect(ledger.isInFlight(id)).toBe(true);
    expect(ledger.isInFlight(id, 1_000, Date.now() + 60_000)).toBe(false);
    expect(ledger.isInFlight(id, 3_600_000)).toBe(true);
    expect(ledger.isInFlight(999999)).toBe(false);
  });

  it('quarantines a corrupt cursor MCP sidecar and creates a fresh reference instead of trusting it', () => {
    const cwd = tempDir();
    const cursorDir = join(cwd, '.cursor');
    const corrupt = 'NOT JSON{{';
    mkdirSync(cursorDir);
    writeFileSync(join(cursorDir, '.heddle-mcp-refs.json'), corrupt);
    materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 });
    expect(JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf8')).mcpServers.memtrace).toBeDefined();
    const quarantined = readdirSync(cursorDir);
    const corruptName = quarantined.find((name) => /^\.heddle-mcp-refs\.json\.corrupt-\d+$/.test(name));
    expect(corruptName).toBeDefined();
    expect(readFileSync(join(cursorDir, corruptName!), 'utf8')).toBe(corrupt);
    expect(JSON.parse(readFileSync(join(cursorDir, '.heddle-mcp-refs.json'), 'utf8')).refs).toHaveProperty('1');
  });

  it('fails a malformed pre-existing cursor MCP file before creating a sidecar or changing its bytes', () => {
    const cwd = tempDir();
    const cursorDir = join(cwd, '.cursor');
    const path = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir);
    writeFileSync(path, 'oops{');
    expect(() => materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 })).toThrow(/not valid JSON/);
    expect(existsSync(join(cursorDir, '.heddle-mcp-refs.json'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('oops{');
  });

  it('leaves a tampered merged cursor MCP file byte-identical while dropping its last heddle reference', () => {
    const cwd = tempDir();
    const path = join(cwd, '.cursor', 'mcp.json');
    const sidecar = join(cwd, '.cursor', '.heddle-mcp-refs.json');
    const restore = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 1 });
    const tampered = '{"mcpServers":{"user-added":{"command":"x","args":[]}}}';
    writeFileSync(path, tampered);
    restore();
    expect(readFileSync(path, 'utf8')).toBe(tampered);
    expect(existsSync(sidecar)).toBe(false);
  });

  it('ignores peer AGENTS.md and cursor MCP materialization churn while still detecting tracked worktree edits', () => {
    const restoreEnv = installPacks();
    try {
      const cwd = tempDir();
      const tracked = join(cwd, 'tracked.txt');
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(tracked, 'base');
      execFileSync('git', ['add', 'tracked.txt'], { cwd });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd });
      const before = snapshotWorktree(cwd);
      const restoreAgents = materializeAgentsMd(cwd, ['alpha'], { dispatchId: 7 });
      const restoreMcp = materializeWorkerMcp(cwd, 'cursor', ['memtrace'], { dispatchId: 7 });
      try {
        expect(sameSnapshot(before, snapshotWorktree(cwd))).toBe(true);
        appendFileSync(tracked, ' changed');
        expect(sameSnapshot(before, snapshotWorktree(cwd))).toBe(false);
      } finally {
        restoreMcp();
        restoreAgents();
      }
    } finally { restoreEnv(); }
  }, 45_000); // snapshot-heavy under parallel forks
});
