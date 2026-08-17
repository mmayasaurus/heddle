import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';

function dispatchRecord() {
  return {
    orchestrator: 'U', taskClass: 'implementation', provider: 'claude', model: 'sonnet',
    skills: 'worker-role', issue: 'HED-99', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null,
  };
}

describe('Ledger in-session reports (temp db)', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-ledger-in-session-test-'));
    ledger = new Ledger(join(dir, 'ledger.db'));
  });
  afterEach(() => {
    ledger?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('counts a confirmed in-session handoff with its tokens', () => {
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');
    expect(ledger.inFlight()).toEqual([]);
    expect(ledger.usageByProvider().find((row) => row.provider === 'claude')).toMatchObject({
      dispatches: 0, refusals: 1, input_tokens: 0, output_tokens: 0,
    });

    expect(ledger.reportInSession(id, { ok: true, inputTokens: 100, outputTokens: 20 })).toBe(true);
    expect(ledger.inFlight()).toEqual([]);
    expect(ledger.usageByProvider().find((row) => row.provider === 'claude')).toMatchObject({
      dispatches: 1, succeeded: 1, refusals: 0, input_tokens: 100, output_tokens: 20,
    });
  });

  it('does not report unknown, subprocess, or true-refusal rows', () => {
    const subprocess = ledger.start(dispatchRecord());
    const refusal = ledger.refuse(dispatchRecord(), 'capability-denied', 'no capability');
    const before = ledger.recent(10);

    expect(ledger.reportInSession(999_999, { ok: true })).toBe(false);
    expect(ledger.reportInSession(subprocess, { ok: true })).toBe(false);
    expect(ledger.reportInSession(refusal, { ok: true })).toBe(false);
    expect(ledger.recent(10)).toEqual(before);
  });

  it('accepts an in-session report once without double-counting', () => {
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');
    expect(ledger.reportInSession(id, { ok: true, inputTokens: 7, outputTokens: 3 })).toBe(true);
    expect(ledger.reportInSession(id, { ok: true, inputTokens: 70, outputTokens: 30 })).toBe(false);
    expect(ledger.usageByProvider().find((row) => row.provider === 'claude')).toMatchObject({
      dispatches: 1, input_tokens: 7, output_tokens: 3,
    });
  });

  it('counts a failed in-session outcome as a failed dispatch', () => {
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');
    expect(ledger.reportInSession(id, { ok: false, error: 'agent timed out' })).toBe(true);
    expect(ledger.inFlight()).toEqual([]);
    expect(ledger.get(id)).toMatchObject({ ok: 0, error: 'agent timed out', refusal: null });
    expect(ledger.usageByProvider().find((row) => row.provider === 'claude')).toMatchObject({
      dispatches: 1, succeeded: 0, refusals: 0,
    });
  });

  it('rejects invalid report numbers without changing the refusal or provider usage', () => {
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');

    expect(() => ledger.reportInSession(id, { ok: true, inputTokens: -1 })).toThrow(TypeError);
    expect(() => ledger.reportInSession(id, { ok: true, outputTokens: 1.5 })).toThrow(TypeError);
    expect(() => ledger.reportInSession(1.5, { ok: true })).toThrow(TypeError);

    expect(ledger.get(id)).toMatchObject({ refusal: 'claude-in-session', ok: 0 });
    expect(ledger.usageByProvider().find((row) => row.provider === 'claude')).toMatchObject({
      dispatches: 0, refusals: 1, input_tokens: 0, output_tokens: 0,
    });
  });

  it('clears a supplied error from a successful in-session report', () => {
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');

    expect(ledger.reportInSession(id, { ok: true, error: 'stale failure' })).toBe(true);

    expect(ledger.get(id)).toMatchObject({ ok: 1, error: null, refusal: null });
  });

  it('only lets the owning orchestrator report an in-session handoff', () => {
    const id = ledger.refuse({ ...dispatchRecord(), orchestrator: 'owner' }, 'claude-in-session', 'run this yourself', 'in-session');

    expect(ledger.reportInSession(id, { ok: true }, 'other')).toBe(false);
    expect(ledger.get(id)).toMatchObject({ refusal: 'claude-in-session', ok: 0 });
    expect(ledger.reportInSession(id, { ok: true }, 'owner')).toBe(true);
    expect(ledger.get(id)).toMatchObject({ refusal: null, ok: 1 });
  });

  it('allows an administrative in-session report without an orchestrator argument', () => {
    const id = ledger.refuse({ ...dispatchRecord(), orchestrator: 'owner' }, 'claude-in-session', 'run this yourself', 'in-session');

    expect(ledger.reportInSession(id, { ok: true })).toBe(true);
    expect(ledger.get(id)).toMatchObject({ refusal: null, ok: 1 });
  });
});
