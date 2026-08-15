import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Split from broker.test.ts (Codacy file-length): same harness, the hold/serialization/state/log half.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../../src/ledger.js';
import { CommsLog } from '../../src/comms/log.js';
import {
  Broker, LedgerTargetState, DEFAULT_MAX_BODY_BYTES, DEFAULT_RATE_LIMIT,
  type BrokerOptions, type Delivery, type PostResult, type TargetState, type TargetStateProvider, type Transport, type TransportOutcome,
} from '../../src/comms/broker.js';

/** A manual gate: the delivery promise stays pending until the test calls `open()`. */
class Gate {
  private resolve: ((outcome: TransportOutcome) => void) | null = null;
  private pending: TransportOutcome | null = null;
  /** Called by FakeTransport when the gated delivery starts. */
  arm(): Promise<TransportOutcome> {
    return new Promise<TransportOutcome>((resolve) => {
      if (this.pending) resolve(this.pending); else this.resolve = resolve;
    });
  }
  /** Let the delivery through (works whether or not it has started yet). */
  open(outcome: TransportOutcome = { ok: true, code: 'injected' }): void {
    if (this.resolve) this.resolve(outcome); else this.pending = outcome;
  }
}
type Behaviour = TransportOutcome | Error | Gate;

class FakeTransport implements Transport {
  readonly name = 'fake';
  calls: Delivery[] = [];
  private behaviours: Behaviour[] = [];

  enqueue(behaviour: Behaviour): void { this.behaviours.push(behaviour); }
  gate(): Gate {
    const gate = new Gate();
    this.behaviours.push(gate);
    return gate;
  }
  async deliver(d: Delivery): Promise<TransportOutcome> {
    this.calls.push(d);
    const behaviour = this.behaviours.shift() ?? { ok: true, code: 'injected' };
    if (behaviour instanceof Error) throw behaviour;
    if (behaviour instanceof Gate) return behaviour.arm();
    return behaviour;
  }
}

class FakeState implements TargetStateProvider {
  states = new Map<string, TargetState>();
  state(address: string): TargetState { return this.states.get(address) ?? 'unknown'; }
}

describe('Broker holds, serialization, target state, delivery log (temp db)', () => {
  let dir: string;
  let log: CommsLog;
  let transport: FakeTransport;
  let state: FakeState;
  let nowMs = 1_000_000;
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 7, 15, 12, 0, tick++)).toISOString();
  const now = () => nowMs;
  const advance = (ms: number) => { nowMs += ms; };
  const newBroker = (over: Partial<BrokerOptions> = {}) => new Broker({
    log, transport, targetState: state, now, ...over,
  });
  const post = (broker: Broker, from = 'K', to = 'R', body = 'hello') => broker.post({ from, to, body });
  const accepted = (result: PostResult): Exclude<PostResult, { outcome: 'refused' }> => {
    if (result.outcome === 'refused') throw new Error(`expected an accepted post, got ${result.code}`);
    return result;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-broker-test-'));
    tick = 0;
    nowMs = 1_000_000;
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    transport = new FakeTransport();
    state = new FakeState();
  });
  afterEach(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('hold at permission gate', () => {
    it('holds at a permission gate and releases after the gate clears', async () => {
      log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker();
      const held = await post(broker, 'K', 'K.1');
      expect(held).toMatchObject({ outcome: 'held', code: 'permission-gate' });
      expect(log.get(accepted(held).messageId)).not.toBeNull();
      expect(log.deliveries()).toMatchObject([{ outcome: 'held', code: 'permission-gate' }]);
      expect(transport.calls).toEqual([]);
      expect(broker.heldMessages()).toMatchObject([{ messageId: accepted(held).messageId, target: 'K.1', attempts: 1 }]); // the hold is attempt 1
      expect(await broker.pump()).toEqual({ released: 0, failed: 0, stillHeld: 1 });
      state.states.set('K.1', 'idle');
      expect(await broker.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 });
      expect(transport.calls).toMatchObject([{ target: 'K.1', attempt: 2 }]);
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'released', code: 'gate-cleared', attempt: 2 });
      expect(broker.heldMessages()).toEqual([]);
    });

    it('fails a held message after the hold timeout without calling transport', async () => {
      log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker({ holdMaxMs: 5000 });
      await post(broker, 'K', 'K.1');
      advance(5001);
      expect(await broker.pump()).toEqual({ released: 0, failed: 1, stillHeld: 0 });
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'failed', code: 'hold-timeout' });
      expect(transport.calls).toEqual([]);
    });

    it('keeps per-target order: a new message queues behind an older held one and is released after it', async () => {
      log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker();
      const first = await post(broker, 'K', 'K.1', 'first');
      state.states.set('K.1', 'idle'); // gate clears before any pump runs…
      const second = await post(broker, 'K', 'K.1', 'second'); // …but the newer message must not overtake
      expect(first).toMatchObject({ outcome: 'held', code: 'permission-gate' });
      expect(second).toMatchObject({ outcome: 'held', code: 'queued-behind-held' });
      expect(transport.calls).toEqual([]);
      expect(await broker.pump()).toEqual({ released: 2, failed: 0, stillHeld: 0 });
      expect(transport.calls.map((c) => c.record.body)).toEqual(['first', 'second']);
    });

    it('retries a held message whose transport failed transiently, until the hold deadline', async () => {
      log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker({ holdMaxMs: 5000 });
      const held = await post(broker, 'K', 'K.1');
      state.states.set('K.1', 'idle');
      transport.enqueue({ ok: false, code: 'no-session', reason: 'blip' });
      expect(await broker.pump()).toEqual({ released: 0, failed: 0, stillHeld: 1 }); // failed attempt is logged, entry kept
      expect(log.deliveries({ messageId: accepted(held).messageId }).map((d) => [d.outcome, d.code, d.attempt]))
        .toEqual([['held', 'permission-gate', 1], ['failed', 'no-session', 2]]);
      expect(await broker.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 }); // next pump succeeds
      expect(log.deliveries({ messageId: accepted(held).messageId }).at(-1)).toMatchObject({ outcome: 'released', code: 'gate-cleared', attempt: 3 });
      // Past the deadline a still-failing transport ends the retry loop with hold-timeout.
      const again = await post(broker, 'K', 'K.1', 'later');
      expect(again).toMatchObject({ outcome: 'sent' });
      state.states.set('K.1', 'permission-gate');
      const h2 = await post(broker, 'K', 'K.1', 'held again');
      state.states.set('K.1', 'idle');
      advance(5001);
      transport.enqueue({ ok: false, code: 'no-session' });
      expect(await broker.pump()).toEqual({ released: 0, failed: 1, stillHeld: 0 });
      expect(log.deliveries({ messageId: accepted(h2).messageId }).at(-1)).toMatchObject({ outcome: 'failed', code: 'hold-timeout' });
    });

    it('a message held while a pump is running is not lost, and overlapping pumps share one run', async () => {
      log.mintChild('K'); log.mintChild('K'); // K.1, K.2
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker();
      await post(broker, 'K', 'K.1', 'A');
      state.states.set('K.1', 'idle');
      const gate = transport.gate();           // A's release will block on this
      const p1 = broker.pump();
      const p2 = broker.pump();
      expect(p2).toBe(p1);                     // one run, not two injections
      await new Promise((r) => setTimeout(r, 0));
      state.states.set('K.2', 'permission-gate');
      const b = await post(broker, 'K', 'K.2', 'B'); // arrives mid-pump
      expect(b).toMatchObject({ outcome: 'held' });
      gate.open();
      expect(await p1).toEqual({ released: 1, failed: 0, stillHeld: 1 });
      expect(broker.heldMessages().map((h) => h.messageId)).toEqual([accepted(b).messageId]); // B survived the pump
      expect(transport.calls.map((c) => c.record.body)).toEqual(['A']);
    });

    it('pumps independent targets concurrently while keeping same-target order', async () => {
      log.mintChild('K'); log.mintChild('K');
      state.states.set('K.1', 'permission-gate'); state.states.set('K.2', 'permission-gate');
      const broker = newBroker();
      await post(broker, 'K', 'K.1', 'to-1');
      await post(broker, 'K', 'K.2', 'to-2');
      state.states.set('K.1', 'idle'); state.states.set('K.2', 'idle');
      const slow = transport.gate();           // K.1's transport stalls…
      const p = broker.pump();
      await new Promise((r) => setTimeout(r, 0));
      expect(transport.calls.map((c) => c.record.body).sort()).toEqual(['to-1', 'to-2']); // …but K.2 was not blocked behind it
      slow.open();
      expect(await p).toEqual({ released: 2, failed: 0, stillHeld: 0 });
    });

    it('a held message is timed out even if the gate has cleared, once holdMaxMs has passed', async () => {
      log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const broker = newBroker({ holdMaxMs: 1000 });
      const held = await post(broker, 'K', 'K.1');
      advance(1001);
      state.states.set('K.1', 'idle');
      expect(await broker.pump()).toEqual({ released: 0, failed: 1, stillHeld: 0 });
      expect(transport.calls).toEqual([]);     // stale instructions are not injected late
      expect(log.deliveries({ messageId: accepted(held).messageId }).at(-1)).toMatchObject({ outcome: 'failed', code: 'hold-timeout', attempt: 2 });
    });

    it('restoreHeld() rebuilds the hold queue from the durable log after a restart', async () => {
      log.mintChild('K'); log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      const before = newBroker();
      const held = await post(before, 'K', 'K.1', 'survive me');
      await post(before, 'K', 'K.2', 'already delivered');
      // "restart": a fresh broker over the same log knows nothing…
      const after = newBroker();
      expect(after.heldMessages()).toEqual([]);
      expect(after.restoreHeld()).toBe(1);     // …until it reads the deliveries: only the still-held one comes back
      expect(after.heldMessages()).toMatchObject([{ messageId: accepted(held).messageId, target: 'K.1' }]);
      expect(after.restoreHeld()).toBe(0);     // idempotent
      state.states.set('K.1', 'idle');
      expect(await after.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 });
      expect(transport.calls.at(-1)).toMatchObject({ target: 'K.1', record: { body: 'survive me' } });
      // once released it is not restored again
      expect(newBroker().restoreHeld()).toBe(0);
    });

    it('restoreHeld() sees a hold whose last event was a transient transport failure, and ignores timed-out ones', async () => {
      log.mintChild('K'); log.mintChild('K');
      state.states.set('K.1', 'permission-gate'); state.states.set('K.2', 'permission-gate');
      const before = newBroker({ holdMaxMs: 1000 });
      const a = await post(before, 'K', 'K.1', 'transient');
      const b = await post(before, 'K', 'K.2', 'expired');
      state.states.set('K.1', 'idle');
      transport.enqueue({ ok: false, code: 'no-session' }); // K.1's release blips → last event 'failed'/'no-session', STILL held
      expect(await before.pump()).toEqual({ released: 0, failed: 0, stillHeld: 2 });
      expect(log.openHolds().map((d) => d.messageId)).toEqual([accepted(a).messageId, accepted(b).messageId]);
      expect(newBroker().restoreHeld()).toBe(2);              // a transient failure does not hide a hold from a restart
      advance(1001);                                          // now both time out → last events 'failed'/'hold-timeout'
      expect(await before.pump()).toEqual({ released: 0, failed: 2, stillHeld: 0 });
      expect(log.openHolds()).toEqual([]);
      expect(newBroker().restoreHeld()).toBe(0);
    });

    it('a throwing target-state provider is reported through onWarning', async () => {
      const warnings: string[] = [];
      const throwing: TargetStateProvider = { state: () => { throw new Error('tracker down'); } };
      await post(newBroker({ targetState: throwing, onWarning: (m) => warnings.push(m) }), 'K', 'R');
      expect(warnings).toEqual([expect.stringContaining('tracker down')]);
    });

    it('a throwing target-state provider does not lose the message: it is treated as unknown and delivered', async () => {
      const throwing: TargetStateProvider = { state: () => { throw new Error('tracker down'); } };
      const result = await post(newBroker({ targetState: throwing }), 'K', 'R');
      expect(result).toMatchObject({ outcome: 'sent' });
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'sent' });
    });

    it('delivers normally for every target state other than permission-gate', async () => {
      for (const targetState of ['busy', 'exited', 'unknown', 'idle'] as const) {
        state.states.set('R', targetState);
        const result = await post(newBroker(), 'K', 'R', targetState);
        expect(result).toMatchObject({ outcome: 'sent' });
      }
      expect(transport.calls).toHaveLength(4);
      expect(log.deliveries().every((d) => d.outcome === 'sent')).toBe(true);
    });
  });


  describe('serialization', () => {
    it('serializes injections to the same target', async () => {
      const broker = newBroker();
      const first = transport.gate();
      const second = transport.gate();
      const p1 = post(broker, 'K', 'R', 'first');
      const p2 = post(broker, 'K', 'R', 'second');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]).toMatchObject({ target: 'R', attempt: 1, record: { id: 1 } });
      first.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1]).toMatchObject({ target: 'R', attempt: 1, record: { id: 2 } });
      second.open();
      await expect(Promise.all([p1, p2])).resolves.toEqual([
        expect.objectContaining({ outcome: 'sent' }), expect.objectContaining({ outcome: 'sent' }),
      ]);
    });

    it('injects to different targets concurrently', async () => {
      const broker = newBroker();
      const r = transport.gate();
      const s = transport.gate();
      const p1 = post(broker, 'K', 'R');
      const p2 = post(broker, 'K', 'S');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.calls.map((call) => call.target).sort()).toEqual(['R', 'S']);
      r.open(); s.open();
      await Promise.all([p1, p2]);
    });
  });


  describe('LedgerTargetState', () => {
    it('reports busy and exited ledger-backed children and unknown for all other addresses', () => {
      const ledger = new Ledger(join(dir, 'ledger.db'));
      try {
        const id = ledger.start({ orchestrator: 'K', taskClass: 'work', provider: 'fake', model: 'fake', skills: null, issue: null, pr: null, cwd: dir, promptPreview: 'x', sessionId: null, fellBackFrom: null });
        log.mintChild('K', { dispatchId: id });
        log.register({ address: 'R' });
        log.mintChild('R');
        const target = new LedgerTargetState(log, ledger);
        expect(target.state('K.1')).toBe('busy');
        ledger.finish(id, { ok: true });
        expect(target.state('K.1')).toBe('exited');
        expect(target.state('missing')).toBe('unknown');
        expect(target.state('R')).toBe('unknown');
        expect(target.state('R.1')).toBe('unknown');
      } finally { ledger.close(); }
    });
  });


  describe('delivery log', () => {
    it('validates delivery data, filters cursor queries, and enforces append-only storage', () => {
      const message = log.append({ from: 'K', to: 'R', body: 'x' });
      expect(() => log.recordDelivery({ from: 'K', to: 'R', outcome: 'wat' as never, code: 'nope' })).toThrow(/unknown delivery outcome/);
      expect(() => log.recordDelivery({ from: 'K', to: 'R', outcome: 'sent', code: 'Bad Code' })).toThrow(/kebab-case/);
      expect(() => log.recordDelivery({ messageId: 0, from: 'K', to: 'R', outcome: 'sent', code: 'injected' })).toThrow(/positive id/);
      expect(() => log.recordDelivery({ messageId: 999, from: 'K', to: 'R', outcome: 'sent', code: 'injected' })).toThrow(/does not exist/);
      expect(() => log.recordDelivery({ messageId: message.id, from: 'K', to: 'R', outcome: 'refused', code: 'rate-limited' })).toThrow(/refused delivery cannot reference/);
      expect(() => log.recordDelivery({ from: 'K', to: 'R', outcome: 'sent', code: 'injected' })).toThrow(/must reference the message/);
      log.register({ address: 'codex-B' }); log.register({ address: 'codex-C' });
      expect(log.participantsWithPrefix('codex').map((p) => p.address)).toEqual(['codex-B', 'codex-C']);
      expect(log.participantsWithPrefix('codex-B').map((p) => p.address)).toEqual(['codex-B']);
      expect(log.participantsWithPrefix('zz')).toEqual([]);
      expect(log.participantsWithPrefix('')).toEqual([]);
      const a = log.recordDelivery({ messageId: message.id, from: 'K', to: 'R', outcome: 'sent', code: 'injected' });
      const b = log.recordDelivery({ messageId: message.id, from: 'R', to: 'K', outcome: 'failed', code: 'no-session' });
      const c = log.recordDelivery({ messageId: null, from: 'K', to: 'S', outcome: 'refused', code: 'unknown-target' });
      expect(log.deliveries({ messageId: message.id }).map((d) => d.id)).toEqual([a.id, b.id]);
      expect(log.deliveries({ target: 'K', sender: 'R' }).map((d) => d.id)).toEqual([b.id]);
      expect(log.deliveries({ sender: 'K', sinceId: a.id }).map((d) => d.id)).toEqual([c.id]);
      const raw = new DatabaseSync(join(dir, 'comms.db'));
      try {
        expect(() => raw.prepare('UPDATE deliveries SET code = \'tampered\' WHERE id = ?').run(a.id)).toThrow(/append-only/);
        expect(() => raw.prepare('DELETE FROM deliveries WHERE id = ?').run(a.id)).toThrow(/append-only/);
      } finally { raw.close(); }
    });
  });
});
