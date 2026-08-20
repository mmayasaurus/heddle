import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommsLog } from '../../src/comms/log.js';
import { pauseReadiness, type InFlightSource } from '../../src/comms/quiesce.js';
import { seal } from '../../src/comms/seal.js';
import { tick, type RotatorDeps, type RotationIntent } from '../../src/rotate/supervisor.js';

/**
 * HED-187 RECEIPT — what an in-session rotator drive does TODAY, end to end.
 *
 * The rotator must run STANDALONE (supervisor doc: "never inside a session it relaunches"), and
 * rotator-bin now REFUSES to start when its raw fleet identity has a live comms session. The
 * refusal is the design-consistent close; this file is the evidence that it is not a LAUNCH
 * BLOCKER — that if the guard were absent and the rotator were driven from inside agent V's
 * session, HED-186's pre-kill quiesce timeout already resolves it SAFELY: a bounded abort that
 * kills nothing, lifts the pause, and NAMES V to the human.
 *
 * The driver cannot ack its own pause — it is a rotator process, not an agent answering comms —
 * so V sits un-acked in its own quiesce ack-set forever. That is the whole failure mode, and it is
 * built here out of the REAL `pauseReadiness` over a real temp comms db rather than a stubbed
 * readiness object: the chain under test is V-in-liveSessions → no ack → describeBlockers names V
 * → tick aborts naming V. Only the three deps the abort branch reads for its clock and its
 * primitives are faked.
 */
describe('HED-187 receipt: an in-session rotator drive bounded-aborts and names the driver', () => {
  let dir: string;
  let log: CommsLog;
  let nowMs: number;
  const clock = () => new Date(nowMs).toISOString();

  /** A ledger that reports nothing in flight — so the ONLY blocker is the un-acked driver. */
  const emptyLedger: InFlightSource = { inFlight: () => [] };

  const operatorDecision = (from: string, to: string) =>
    seal({ from, to, tier: 'operator' as const, verified: true, evidence: null,
      code: 'operator-token', reason: 'test', dispatchId: null, requestedTier: null, downgradedFrom: null });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-hed187-'));
    nowMs = Date.parse('2026-08-19T09:00:00.000Z');
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    log.register({ address: 'operator' });
  });
  afterEach(() => { log.close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('a rotation driven from inside V\'s session aborts (nothing killed, pause lifted) and the escalation names V', async () => {
    // Agent V is live BEFORE the pause — this is the rotator's own session, the one the guard in
    // rotator-bin.ts now refuses to start inside (raw fleet identity V ∈ log.liveSessions()).
    log.register({ address: 'V' });
    log.registerSession({ address: 'V', sessionId: 's-V', sessionName: 'V' });
    expect(log.liveSessions().map((s) => s.address)).toContain('V'); // the exact condition the bin guard tests

    nowMs += 1_000;
    const pause = log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'FLEET PAUSE — account rotation',
        meta: { fleetPause: { reason: 'account rotation' } } },
      operatorDecision('operator', '@all'),
    );

    // V never acks: the driver is a rotator process waiting on the fleet, not an agent answering
    // comms — it cannot ack the pause it is itself blocked on. REAL readiness, not a stub.
    const readiness = pauseReadiness(log, emptyLedger);
    expect(readiness.pauseId).toBe(pause.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.pending).toEqual(['V']);
    expect(readiness.blockers).toContain('1 live agent(s) have not acked: V');

    // Wall-clock has passed the pre-kill quiesce deadline (HED-186); nothing has been killed yet.
    const intent: RotationIntent = { target: 'acct2', from: 'acct1', roster: ['V'] };
    const needsHumanMsgs: string[] = [];
    const resumed: string[] = [];
    const killed: string[] = [];
    const relaunched: string[] = [];
    const abortsRecorded: { target: string; pauseId: number }[] = [];
    const deps: RotatorDeps = {
      decide: () => ({ action: 'idle', current: 'acct1', usedPct: 92, reason: 'a pause is in force' }),
      readiness: () => pauseReadiness(log, emptyLedger),   // re-read live, exactly as the daemon does
      pauseIntent: () => intent,
      liveAddresses: () => log.liveSessions().filter((s) => s.address !== 'operator').map((s) => s.address),
      isRelaunched: () => false,
      wasRelaunched: () => false,                          // no roster member relaunched ⇒ noProgress
      markRelaunched: async () => undefined,
      verifyTimeout: () => ({ timedOut: false, timeoutMs: 300_000 }),
      quiesceTimeout: () => ({ timedOut: true, timeoutMs: 1_200_000 }),  // past the PRE-KILL deadline
      requestPause: async () => { throw new Error('a pause is already in force'); },
      resumePause: async (reason) => { resumed.push(reason); },
      killSession: async (a) => { killed.push(a); return { ok: true, code: 'killed' }; },
      relaunch: async (a) => { relaunched.push(a); return { ok: true, code: 'launched' }; },
      recordAbort: async (target, pauseId) => { abortsRecorded.push({ target, pauseId }); },
      abortCooldownActive: () => false,
      needsHuman: async (m) => { needsHumanMsgs.push(m); },
    };

    const step = await tick(deps);

    // BOUNDED, not a deadlock: the rotation gives up instead of holding the fleet paused forever.
    expect(step.phase).toBe('aborted');
    expect(killed).toEqual([]);                 // nothing irreversible happened to the driver's session
    expect(relaunched).toEqual([]);
    expect(resumed).toHaveLength(1);            // the pause is LIFTED — the fleet is not stranded
    expect(resumed[0]).toMatch(/ABORTED/);
    expect(resumed[0]).toMatch(/no session was killed/);
    expect(abortsRecorded).toEqual([{ target: 'acct2', pauseId: pause.id }]);  // HED-200 cooldown stamped

    // …and the human is told WHO wedged it. This is the half that makes the refusal a hygiene fix
    // rather than a launch blocker: an operator who starts the rotator in V's terminal gets V's name.
    expect(needsHumanMsgs).toHaveLength(1);
    expect(needsHumanMsgs[0]).toContain('V');
    expect(needsHumanMsgs[0]).toContain('have not acked: V');
    expect(needsHumanMsgs[0]).toMatch(/did not quiesce within 1200000ms/);
    expect(needsHumanMsgs[0]).toMatch(/nothing killed/);
  });
});
