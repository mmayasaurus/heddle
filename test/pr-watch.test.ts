import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatWatchStateFile, hasSeenKey, runPrWatch, type GhRunner } from '../src/pr-watch.js';

const stateDirs: string[] = [];
afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-pr-watch-'));
  stateDirs.push(dir);
  return dir;
}

interface Fixture {
  sha?: string;
  threads?: unknown[];
  reviews?: unknown[];
  checks?: unknown[];
  fail?: 'threads' | 'reviews' | 'gate';
}

function ghFor({ sha = 'abcdef123456', threads = [], reviews = [], checks = [], fail }: Fixture = {}): GhRunner {
  return (args) => {
    const command = args.join(' ');
    if (command === 'pr view 7 --repo acme/widgets --json headRefOid') return JSON.stringify({ headRefOid: sha });
    if (command.startsWith('api graphql')) {
      if (fail === 'threads') throw new Error('graphql unavailable');
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });
    }
    if (command === 'pr view 7 --repo acme/widgets --json reviews') {
      if (fail === 'reviews') throw new Error('reviews unavailable');
      return JSON.stringify({ reviews });
    }
    if (command === 'pr view 7 --repo acme/widgets --json statusCheckRollup') {
      if (fail === 'gate') throw new Error('checks unavailable');
      return JSON.stringify({ statusCheckRollup: checks });
    }
    throw new Error(`unexpected gh call: ${command}`);
  };
}

const thread = { id: 'T_1', isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' }, path: 'src/a.ts', line: 12 }] } };
const review = { author: { login: 'bot' }, submittedAt: '2026-08-28T12:00:00Z', state: 'COMMENTED', body: 'Please fix this.' };

describe('PR watch', () => {
  it('emits a new item once and records its state key', () => {
    const dir = stateDir();
    const result = runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', ghFor({ threads: [thread] }));
    expect(result.lines).toEqual(['[thread] reviewer src/a.ts:12 id=T_1']);
    const state = readFileSync(formatWatchStateFile(dir, 'acme/widgets', '7'), 'utf8');
    expect(hasSeenKey(state, 'thread:T_1')).toBe(true);
  });

  it('deduplicates identical items on a second poll pass', () => {
    const dir = stateDir();
    const gh = ghFor({ threads: [thread], reviews: [review] });
    runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', gh);
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', gh).lines).toEqual([]);
  });

  it('seeds current items silently and emits a genuinely new item later', () => {
    const dir = stateDir();
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir, seed: true }, '/repo', ghFor({ threads: [thread] })).lines).toEqual([]);
    const later = { ...thread, id: 'T_2' };
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', ghFor({ threads: [thread, later] })).lines).toEqual(['[thread] reviewer src/a.ts:12 id=T_2']);
  });

  it('reset clears prior state before polling again', () => {
    const dir = stateDir();
    const gh = ghFor({ threads: [thread] });
    runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', gh);
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir, reset: true }, '/repo', gh).lines).toEqual(['[thread] reviewer src/a.ts:12 id=T_1']);
  });

  it('surfaces a failed channel as a watch error', () => {
    const result = runPrWatch('7', { repo: 'acme/widgets', stateDir: stateDir() }, '/repo', ghFor({ fail: 'reviews' }));
    expect(result.lines).toEqual(expect.arrayContaining([expect.stringContaining('[watch-error] reviews query failed (gh)')]));
  });

  it('keys gate conclusions by SHA so the same conclusion at a new head re-emits', () => {
    const dir = stateDir();
    const first = ghFor({ sha: 'abcdef123456', checks: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const second = ghFor({ sha: 'fedcba987654', checks: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', first).lines).toContain('[gate] SUCCESS @abcdef123');
    expect(runPrWatch('7', { repo: 'acme/widgets', stateDir: dir }, '/repo', second).lines).toContain('[gate] SUCCESS @fedcba987');
  });
});
