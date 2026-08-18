import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommsLog } from '../../src/comms/log.js';
import { seal } from '../../src/comms/seal.js';
import { createRotatorDeps } from '../../src/rotate/live.js';
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
});
