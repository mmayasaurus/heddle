import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommsLog } from '../../src/comms/log.js';
import { dueForNudge, idleAgents, shouldRunNudger, transcriptActivityAt } from '../../src/comms/nudge.js';
import { seal } from '../../src/comms/seal.js';

/**
 * Idle-nudger (HED-137). The interesting cases are the ones where it must NOT fire: a working
 * agent, an agent whose activity cannot be determined, and an agent already nudged this window.
 * A nudger that cries wolf gets ignored, which costs more than not having one.
 */
describe('idle nudger (temp db + temp projects dir)', () => {
  let dir: string;
  let projectsDir: string;
  let log: CommsLog;
  let nowMs: number;
  const clock = () => new Date(nowMs).toISOString();
  const opts = () => ({ projectsDir, now: () => nowMs, idleMs: 15 * 60_000, cooldownMs: 15 * 60_000 });

  const agentDecision = (from: string, to: string) =>
    seal({ from, to, tier: 'agent-message' as const, verified: false, evidence: null,
      code: 'unverified', reason: 'test', dispatchId: null, requestedTier: null, downgradedFrom: null });

  /** Register a live session and give it a transcript last written `quietMs` ago. */
  const session = (address: string, sessionId: string, quietMs: number | null) => {
    log.register({ address });
    log.registerSession({ address, sessionId, sessionName: address });
    if (quietMs === null) return;              // no transcript at all
    const proj = join(projectsDir, `-Users-someone-project-${address}`);
    mkdirSync(proj, { recursive: true });
    const file = join(proj, `${sessionId}.jsonl`);
    writeFileSync(file, '{}\n');
    const when = new Date(nowMs - quietMs);
    utimesSync(file, when, when);
  };

  /** Production keeps a session live with a 30s heartbeat regardless of whether the agent is
   *  working — that is exactly why idleness cannot be read from the heartbeat. Tests that advance
   *  the clock must do the same, or the session ages out of `liveSessions()` and vanishes. */
  const heartbeat = (address: string) => log.heartbeatSession(address);

  const nudge = (address: string) =>
    log.append({ from: 'operator', to: address, kind: 'status', body: 'nudge',
      meta: { nudge: { idleMs: 1 } } }, agentDecision('operator', address));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-nudge-'));
    projectsDir = join(dir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    nowMs = Date.parse('2026-08-17T21:00:00.000Z');
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    log.register({ address: 'operator' });
  });
  afterEach(() => { log.close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('nudges an agent whose transcript has been quiet past the threshold', () => {
    session('V', 's-V', 40 * 60_000);
    const idle = idleAgents(log, opts());
    expect(idle.map((a) => a.address)).toEqual(['V']);
    expect(idle[0]?.idleMs).toBe(40 * 60_000);
    expect(dueForNudge(log, opts()).map((a) => a.address)).toEqual(['V']);
  });

  it('does NOT nudge an agent that is actively working', () => {
    session('V', 's-V', 30_000);           // wrote half a minute ago
    expect(idleAgents(log, opts())).toEqual([]);
    expect(dueForNudge(log, opts())).toEqual([]);
  });

  it('does NOT nudge when activity cannot be determined — unknown is not idle', () => {
    session('V', 's-V', null);             // live session, no transcript anywhere
    expect(transcriptActivityAt('s-V', opts())).toBeNull();
    expect(idleAgents(log, opts())).toEqual([]);
  });

  it('respects the cooldown, then nudges again once the window passes', () => {
    session('V', 's-V', 40 * 60_000);
    nudge('V');
    expect(dueForNudge(log, opts())).toEqual([]);          // just nudged

    nowMs += 14 * 60_000;                                   // still inside the window
    heartbeat('V');
    expect(dueForNudge(log, opts())).toEqual([]);

    nowMs += 2 * 60_000;                                    // 16m since the nudge
    heartbeat('V');
    expect(dueForNudge(log, opts()).map((a) => a.address)).toEqual(['V']);
  });

  it('does not nudge a session that has gone stale — a dead window is not an idle agent', () => {
    session('V', 's-V', 40 * 60_000);
    expect(idleAgents(log, opts()).map((a) => a.address)).toEqual(['V']);
    // No heartbeat for two minutes: the channel server is gone, so there is nothing to nudge and
    // no one to read it.
    nowMs += 2 * 60_000;
    expect(idleAgents(log, opts())).toEqual([]);
  });

  it('never nudges the operator — a human reading their screen is not a stalled agent', () => {
    log.registerSession({ address: 'operator', sessionId: 's-op', sessionName: 'operator' });
    const proj = join(projectsDir, '-op');
    mkdirSync(proj, { recursive: true });
    const file = join(proj, 's-op.jsonl');
    writeFileSync(file, '{}\n');
    const when = new Date(nowMs - 60 * 60_000);
    utimesSync(file, when, when);

    expect(idleAgents(log, opts()).map((a) => a.address)).toEqual([]);
  });

  it('picks out only the quiet sessions when the fleet is mixed', () => {
    session('V', 's-V', 40 * 60_000);      // idle
    session('T', 's-T', 20_000);           // working
    session('U', 's-U', 61 * 60_000);      // very idle
    expect(idleAgents(log, opts()).map((a) => a.address).sort()).toEqual(['U', 'V']);
  });

  it('runs the loop ONLY in an operator session with push on — otherwise every session nudges', () => {
    expect(shouldRunNudger(true, true)).toBe(true);
    expect(shouldRunNudger(false, true)).toBe(false);   // an ordinary agent must not nudge peers
    expect(shouldRunNudger(true, false)).toBe(false);   // pull-only: no channel to inject into
  });

  it('reads the cooldown from the LOG, so a nudger restart cannot re-nudge everyone', () => {
    session('V', 's-V', 40 * 60_000);
    nudge('V');
    // A brand-new CommsLog stands in for the nudger's process restarting: the cooldown survives
    // because it was never held in memory.
    const reopened = new CommsLog(join(dir, 'comms.db'), { now: clock });
    try {
      expect(reopened.lastNudgeAt('V')).toBe(clock());
      expect(dueForNudge(reopened, opts())).toEqual([]);
    } finally { reopened.close?.(); }
  });
});
