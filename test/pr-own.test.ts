import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveOwnerId, markerBody, parseMarker } from '../src/pr-own.js';

describe('PR ownership helpers', () => {
  it('uses the linked worktree name from a .worktrees directory', () => {
    expect(deriveOwnerId({ topLevel: '/repos/heddle/.worktrees/T-docs', branch: 'feature' })).toBe('T-docs');
  });

  it('uses the branch name for a bare checkout', () => {
    expect(deriveOwnerId({ topLevel: '/repos/heddle', branch: 'feature/pr-own' })).toBe('feature/pr-own');
  });

  it('uses a stable absolute-path hash for detached HEAD', () => {
    const topLevel = '/repos/heddle';
    const expected = createHash('sha256').update(topLevel).digest('hex').slice(0, 8);
    expect(deriveOwnerId({ topLevel, branch: null })).toBe(expected);
  });

  it('regression HED-414 — distinct bare main checkouts do not collide', () => {
    expect(deriveOwnerId({ topLevel: '/repos/one', branch: 'main' }))
      .not.toBe(deriveOwnerId({ topLevel: '/repos/two', branch: 'main' }));
  });

  it('prefers the explicit HEDDLE_PR_OWNER override', () => {
    expect(deriveOwnerId({ topLevel: '/repos/heddle', branch: 'main', override: 'operator-1' })).toBe('operator-1');
  });

  it('formats and parses a PR-OWNER marker', () => {
    const marker = markerBody('T-docs', '2026-08-28T12:00:00Z', '2026-08-28T13:00:00Z');
    expect(marker).toContain('<!-- PR-OWNER owner=T-docs since=2026-08-28T12:00:00Z heartbeat=2026-08-28T13:00:00Z -->');
    expect(parseMarker(marker)).toEqual({
      owner: 'T-docs', since: '2026-08-28T12:00:00Z', heartbeat: '2026-08-28T13:00:00Z',
    });
  });
});
