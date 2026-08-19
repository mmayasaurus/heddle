import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommsLog } from '../../src/comms/log.js';
import { seal } from '../../src/comms/seal.js';
import { createRotatorDeps, DEFAULT_VERIFY_TIMEOUT_MS } from '../../src/rotate/live.js';
import type { Broker } from '../../src/comms/broker.js';

/**
 * Live-adapter parts that don't need a fleet: the pause-meta round-trip (the requestPause↔pauseIntent
 * contract) and isRelaunched against a temp session registry. The exec (fleet-kill/relaunch) and
 * broker-post paths are integration and are proven in the one supervised live run, not here.
 */
describe('createRotatorDeps — testable parts', () => {
  let dir: string;
  let log: CommsLog;
  let nowMs: number;
  const clock = () => new Date(nowMs).toISOString();
  const dummyBroker = {} as Broker; // pauseIntent/isRelaunched never touch the broker

  const operatorDecision = (to = '@all') =>
    seal({ from: 'operator', to, tier: 'operator' as const, verified: true, evidence: null,
      code: 'operator-token', reason: 'test', dispatchId: null, requestedTier: null, downgradedFrom: null });

  const deps = (sessionsDir?: string, only?: string[]) =>
    createRotatorDeps({ log, broker: dummyBroker, inFlight: null, usageDir: dir, scriptsDir: dir, now: () => nowMs, ...(sessionsDir ? { sessionsDir } : {}), ...(only ? { only } : {}) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-rotate-live-'));
    nowMs = Date.parse('2026-08-17T22:00:00.000Z');
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    log.register({ address: 'operator' });
    log.register({ address: 'V' });
    log.register({ address: 'R' });
    log.register({ address: 'S' });
  });
  afterEach(() => { log.close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('liveAddresses excludes the operator and, when `only` is set, restricts to that scope', () => {
    log.registerSession({ address: 'R', sessionId: 's-R', sessionName: 'R' });
    log.registerSession({ address: 'S', sessionId: 's-S', sessionName: 'S' });
    log.registerSession({ address: 'V', sessionId: 's-V', sessionName: 'V' });
    log.registerSession({ address: 'operator', sessionId: 's-op', sessionName: 'operator' });
    expect(deps().liveAddresses().sort()).toEqual(['R', 'S', 'V']);      // operator excluded
    expect(deps(undefined, ['V']).liveAddresses()).toEqual(['V']);        // scoped to one subject
    expect(deps(undefined, ['R', 'V']).liveAddresses().sort()).toEqual(['R', 'V']);
  });

  it('pauseIntent reads back the rotation plan stamped into an operator pause meta', () => {
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'FLEET PAUSE — rotation',
        meta: { fleetPause: { reason: 'acct1 at 92%', rotation: { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] } } } },
      operatorDecision(),
    );
    expect(deps().pauseIntent()).toEqual({ target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] });
  });

  it('pauseIntent is null for a pause with no rotation plan (a manual operator pause)', () => {
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'manual pause', meta: { fleetPause: { reason: 'by hand' } } },
      operatorDecision(),
    );
    expect(deps().pauseIntent()).toBeNull();
  });

  it('pauseIntent is null when no pause is in force', () => {
    expect(deps().pauseIntent()).toBeNull();
  });

  it('isRelaunched: a session whose registry startedAt post-dates the pause is the relaunched one', () => {
    // Pause at nowMs; then a session registry entry started AFTER it.
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    // A registry entry for V that started 10s after the pause, pid = this process (guaranteed alive).
    writeFileSync(join(sessionsDir, 'v.json'), JSON.stringify({ name: 'V', pid: process.pid, startedAt: nowMs + 10_000 }), 'utf8');
    expect(deps(sessionsDir).isRelaunched('V')).toBe(true);
  });

  it('isRelaunched: an OLD session (startedAt before the pause) is not the relaunched one', () => {
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'v.json'), JSON.stringify({ name: 'V', pid: process.pid, startedAt: nowMs - 60_000 }), 'utf8');
    expect(deps(sessionsDir).isRelaunched('V')).toBe(false);
  });

  it('isRelaunched: a registry entry for a DEAD pid does not count as live/relaunched', () => {
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    // pid 2^31-1 is not a real live process; even with a post-pause startedAt it must not count.
    writeFileSync(join(sessionsDir, 'v.json'), JSON.stringify({ name: 'V', pid: 2147483646, startedAt: nowMs + 10_000 }), 'utf8');
    expect(deps(sessionsDir).isRelaunched('V')).toBe(false);
  });

  it('wasRelaunched finds THIS pause\'s marker even past a >500-message operator inbox (oldest-first regression)', () => {
    // The buggy scan read transcript(limit:500) oldest-first, so once the operator inbox exceeded 500
    // the current pause's relaunch marker fell outside the window and wasRelaunched returned false
    // forever — re-relaunching an already-relaunched session. The sinceId:p.id fix scopes to messages
    // posted after the pause, where the marker always is.
    for (let i = 0; i < 550; i++) {
      log.append({ from: 'operator', to: 'operator', kind: 'status', body: `filler ${i}` }, operatorDecision('operator'));
    }
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    const pause = log.latestFleetPause();
    expect(pause).not.toBeNull();
    log.append(
      { from: 'operator', to: 'operator', kind: 'status', body: `rotation ${pause!.id}: relaunched V`,
        meta: { rotationRelaunched: { pauseId: pause!.id, address: 'V' } } },
      operatorDecision('operator'),
    );
    expect(deps().wasRelaunched('V')).toBe(true);   // false before the fix — marker sat past the 500-window
    expect(deps().wasRelaunched('R')).toBe(false);  // no marker for R
  });

  it('needsHuman de-dupes against the latest alert since the pause, not the oldest inbox message', async () => {
    const posted: string[] = [];
    const broker = { post: async (m: { body: string }) => { posted.push(m.body); } } as unknown as Broker;
    const d = createRotatorDeps({ log, broker, inFlight: null, usageDir: dir, scriptsDir: dir, now: () => nowMs });
    // An ancient needs-human BEFORE the pause — what the buggy limit:1 (oldest) scan compared against.
    log.append({ from: 'operator', to: 'operator', kind: 'needs-human', body: 'ancient alert' }, operatorDecision('operator'));
    for (let i = 0; i < 520; i++) log.append({ from: 'operator', to: 'operator', kind: 'status', body: `f${i}` }, operatorDecision('operator'));
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    // This rotation already posted a needs-human — it sits AFTER the pause, unlike the ancient one.
    log.append({ from: 'operator', to: 'operator', kind: 'needs-human', body: 'kill refused for V' }, operatorDecision('operator'));
    await d.needsHuman('kill refused for V');   // matches the latest alert since the pause → must de-dupe
    expect(posted).toEqual([]);                  // buggy code compared vs the ancient one and WOULD have posted
  });

  it('needsHuman: two distinct alerts alternating across ticks each post ONCE, not spam every tick (HED-157)', async () => {
    const posted: string[] = [];
    // Stub broker that records AND appends to the log, so each de-dupe scan sees prior posts.
    const broker = { post: async (m: { body: string }) => {
      posted.push(m.body);
      log.append({ from: 'operator', to: 'operator', kind: 'needs-human', body: m.body }, operatorDecision('operator'));
    } } as unknown as Broker;
    const d = createRotatorDeps({ log, broker, inFlight: null, usageDir: dir, scriptsDir: dir, now: () => nowMs });
    log.append(
      { from: 'operator', to: '@all', kind: 'status', body: 'pause',
        meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
      operatorDecision(),
    );
    // A VERIFY-timeout warning (item 1) and a late-joiner warning (item 2) alternate tick-to-tick. A
    // last-only de-dupe re-posts BOTH every round (each looks new against the other); `.some` posts each once.
    for (let round = 0; round < 3; round++) {
      await d.needsHuman('timeout: X did not come back');
      await d.needsHuman('joiner: Y joined during the pause');
    }
    expect(posted).toEqual(['timeout: X did not come back', 'joiner: Y joined during the pause']);
  });

  describe('verifyTimeout (HED-157)', () => {
    it('is never timed out when no pause is in force', () => {
      expect(deps().verifyTimeout()).toEqual({ timedOut: false, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS });
    });

    it('anchors the deadline to the LATEST relaunch-marker time, not the pause start', () => {
      // Quiesce (waiting for every live agent to ack + park) is unbounded, so the relaunch marker for
      // V doesn't land until 6 minutes after the pause — already past a 5-minute window if (wrongly)
      // measured from the pause start. "Now" is only 1 minute after the MARKER.
      log.append(
        { from: 'operator', to: '@all', kind: 'status', body: 'pause',
          meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
        operatorDecision(),
      );
      const pause = log.latestFleetPause()!;
      nowMs += 6 * 60_000; // the marker lands 6 minutes after the pause
      log.append(
        { from: 'operator', to: 'operator', kind: 'status', body: `rotation ${pause.id}: relaunched V`,
          meta: { rotationRelaunched: { pauseId: pause.id, address: 'V' } } },
        operatorDecision('operator'),
      );
      nowMs += 60_000; // "now" is 1 minute after the MARKER (7 minutes after the pause)
      const result = deps().verifyTimeout();
      expect(result.timedOut).toBe(false); // would be TRUE if (wrongly) anchored to the pause start
    });

    it('times out once elapsed time SINCE THE MARKER exceeds the configured timeout', () => {
      log.append(
        { from: 'operator', to: '@all', kind: 'status', body: 'pause',
          meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
        operatorDecision(),
      );
      const pause = log.latestFleetPause()!;
      nowMs += 60_000; // the marker lands 1 minute after the pause
      log.append(
        { from: 'operator', to: 'operator', kind: 'status', body: `rotation ${pause.id}: relaunched V`,
          meta: { rotationRelaunched: { pauseId: pause.id, address: 'V' } } },
        operatorDecision('operator'),
      );
      nowMs += 6 * 60_000; // 6 minutes after the MARKER — past the 5-minute default
      const result = deps().verifyTimeout();
      expect(result.timedOut).toBe(true);
      expect(result.timeoutMs).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
    });

    it('falls back to the pause time when no relaunch marker exists yet (defensive — not the real tick() path)', () => {
      log.append(
        { from: 'operator', to: '@all', kind: 'status', body: 'pause',
          meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
        operatorDecision(),
      );
      nowMs += 6 * 60_000; // 6 minutes after the pause, no marker ever posted
      expect(deps().verifyTimeout().timedOut).toBe(true);
    });

    it('honours a custom verifyTimeoutMs', () => {
      log.append(
        { from: 'operator', to: '@all', kind: 'status', body: 'pause',
          meta: { fleetPause: { reason: 'r', rotation: { target: 'acct2', from: 'acct1', roster: ['V'] } } } },
        operatorDecision(),
      );
      const pause = log.latestFleetPause()!;
      log.append(
        { from: 'operator', to: 'operator', kind: 'status', body: `rotation ${pause.id}: relaunched V`,
          meta: { rotationRelaunched: { pauseId: pause.id, address: 'V' } } },
        operatorDecision('operator'),
      );
      nowMs += 2_000; // 2 seconds after the marker
      const custom = createRotatorDeps({
        log, broker: dummyBroker, inFlight: null, usageDir: dir, scriptsDir: dir, now: () => nowMs, verifyTimeoutMs: 1_000,
      });
      const result = custom.verifyTimeout();
      expect(result.timeoutMs).toBe(1_000);
      expect(result.timedOut).toBe(true); // 2s elapsed > 1s timeout
    });
  });
});
