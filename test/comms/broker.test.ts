import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('Broker (temp db)', () => {
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

  describe('addressing', () => {
    it('posts exact addresses to themselves and resolves a unique registered prefix', async () => {
      const broker = newBroker();
      await post(broker, 'K', 'K');
      log.register({ address: 'codex-B' });
      const result = await post(broker, 'K', 'codex');
      expect(result).toMatchObject({ outcome: 'sent', to: 'codex-B' });
      expect(log.get(accepted(result).messageId)!).toMatchObject({ to: 'codex-B', meta: { resolvedFrom: 'codex' } });
      expect(transport.calls.map((c) => c.target)).toEqual(['K', 'codex-B']);
      // resolvedFrom is broker-authored provenance: a caller cannot plant it, and it is absent without expansion.
      const planted = await broker.post({ from: 'K', to: 'codex-B', body: 'x', meta: { resolvedFrom: 'fake', keep: 1 } });
      expect(log.get(accepted(planted).messageId)!.meta).toEqual({ keep: 1, envelopeVersion: 1, tierCode: 'target-not-child', tierReason: expect.any(String) });
    });

    it('refuses an ambiguous prefix without a message and logs the refusal', async () => {
      log.register({ address: 'K' });
      log.register({ address: 'codex-B' });
      log.register({ address: 'codex-C' });
      const result = await post(newBroker(), 'K', 'codex');
      expect(result).toMatchObject({ outcome: 'refused', code: 'ambiguous-target', candidates: ['codex-B', 'codex-C'] });
      expect(log.count()).toBe(0);
      expect(log.deliveries()).toMatchObject([{ outcome: 'refused', code: 'ambiguous-target', messageId: null }]);
      expect(log.deliveries()[0].reason).toMatch(/codex-B.*codex-C/);
    });

    it('refuses and logs an unknown target, but accepts a valid address nobody has used yet', async () => {
      const broker = newBroker();
      const result = await post(broker, 'K', 'no such target');
      expect(result).toMatchObject({ outcome: 'refused', code: 'unknown-target' });
      expect(log.deliveries()).toMatchObject([{ outcome: 'refused', code: 'unknown-target', messageId: null }]);
      // A syntactically valid, unregistered agent id is a real target (it just has not spoken yet).
      expect(await post(broker, 'K', 'missing')).toMatchObject({ outcome: 'sent', to: 'missing' });
      // Registered participants win over the bare grammar: with K.1 and K.2 minted, "K." is ambiguous, "K.1" exact.
      log.mintChild('K'); log.mintChild('K');
      expect(await post(broker, 'K', 'K.')).toMatchObject({ outcome: 'refused', code: 'ambiguous-target', candidates: ['K.1', 'K.2'] });
      expect(await post(broker, 'K', 'K.1')).toMatchObject({ outcome: 'sent', to: 'K.1' });
    });

    it('resolves @orchestrator for a minted child and refuses it for a non-child', async () => {
      log.mintChild('K');
      const broker = newBroker();
      const child = await post(broker, 'K.1', '@orchestrator');
      const other = await post(broker, 'R', '@orchestrator');
      expect(child).toMatchObject({ outcome: 'sent', to: 'K' });
      expect(other).toMatchObject({ outcome: 'refused', code: 'no-orchestrator' });
      expect(log.get(accepted(child).messageId)?.to).toBe('K');
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'refused', code: 'no-orchestrator', messageId: null });
    });

    it('throws for invalid or non-sending bound senders', async () => {
      const broker = newBroker();
      await expect(post(broker, '#fleet')).rejects.toThrow(/invalid or non-sending/);
      await expect(post(broker, 'K L')).rejects.toThrow(/invalid or non-sending/);
      expect(log.count()).toBe(0);
      expect(log.deliveries()).toEqual([]);
    });
  });

  describe('size cap', () => {
    it('accepts exactly the default byte cap and refuses one byte over with a logged refusal', async () => {
      const broker = newBroker();
      const accepted = await post(broker, 'K', 'R', 'x'.repeat(DEFAULT_MAX_BODY_BYTES));
      const refused = await post(broker, 'K', 'R', 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1));
      expect(accepted).toMatchObject({ outcome: 'sent' });
      expect(refused).toMatchObject({ outcome: 'refused', code: 'body-too-large' });
      expect(refused.reason).toContain(String(DEFAULT_MAX_BODY_BYTES + 1));
      expect(log.count()).toBe(1);
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'refused', code: 'body-too-large', messageId: null });
    });

    it('counts UTF-8 bytes rather than JavaScript characters', async () => {
      const broker = newBroker();
      const accepted = await post(broker, 'K', 'R', '€'.repeat(2730));
      const refused = await post(broker, 'K', 'R', '€'.repeat(2731));
      expect(accepted).toMatchObject({ outcome: 'sent' });
      expect(refused).toMatchObject({ outcome: 'refused', code: 'body-too-large' });
      expect(refused.reason).toContain('8193');
      expect(log.count()).toBe(1);
    });

    it('honours a custom maximum body size', async () => {
      const result = await post(newBroker({ maxBodyBytes: 10 }), 'K', 'R', 'é'.repeat(6));
      expect(result).toMatchObject({ outcome: 'refused', code: 'body-too-large' });
      expect(log.deliveries()).toMatchObject([{ messageId: null, code: 'body-too-large' }]);
    });
  });

  describe('rate limit', () => {
    it('enforces the burst limit, logs the refusal, and does not charge refusals', async () => {
      const broker = newBroker();
      await post(broker); await post(broker); await post(broker);
      const refused = await post(broker);
      expect(refused).toMatchObject({ outcome: 'refused', code: 'rate-limited', retryAfterMs: 1000 });
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'refused', code: 'rate-limited', messageId: null });
      advance(1000);
      expect(await post(broker)).toMatchObject({ outcome: 'sent' });
    });

    it('enforces the ten-second pair window and releases capacity at its edge', async () => {
      const broker = newBroker();
      await post(broker); await post(broker); await post(broker);
      advance(1000); await post(broker);
      advance(1000); await post(broker);
      advance(1000);
      expect(await post(broker)).toMatchObject({ outcome: 'refused', code: 'rate-limited', retryAfterMs: 7000 });
      advance(7000);
      expect(await post(broker)).toMatchObject({ outcome: 'sent' });
    });

    it('keeps rate budgets independent for each sender-target pair', async () => {
      const broker = newBroker();
      await post(broker); await post(broker); await post(broker);
      expect(await post(broker)).toMatchObject({ outcome: 'refused', code: 'rate-limited' });
      expect(await post(broker, 'K', 'S')).toMatchObject({ outcome: 'sent' });
      expect(await post(broker, 'R', 'K')).toMatchObject({ outcome: 'sent' });
      expect(transport.calls).toHaveLength(5);
    });

    it('honours a custom rate limit', async () => {
      const broker = newBroker({ rateLimit: { max: 1, burst: 1 } });
      expect(await post(broker)).toMatchObject({ outcome: 'sent' });
      expect(await post(broker)).toMatchObject({ outcome: 'refused', code: 'rate-limited' });
      expect(log.deliveries()).toHaveLength(2);
    });
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
      expect(broker.heldMessages()).toMatchObject([{ messageId: accepted(held).messageId, target: 'K.1', attempts: 0 }]);
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
        .toEqual([['held', 'permission-gate', 1], ['failed', 'no-session', 1]]);
      expect(await broker.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 }); // next pump succeeds
      expect(log.deliveries({ messageId: accepted(held).messageId }).at(-1)).toMatchObject({ outcome: 'released', code: 'gate-cleared', attempt: 2 });
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

  describe('rooms and broadcast', () => {
    it('logs room posts for pull without calling transport', async () => {
      const result = await post(newBroker(), 'K', '#fleet');
      expect(result).toMatchObject({ outcome: 'logged', code: 'room-pull' });
      expect(transport.calls).toEqual([]);
      expect(log.deliveries()).toMatchObject([{ outcome: 'logged', code: 'room-pull' }]);
    });

    it('broadcasts to every other registered participant and reports a partial failure', async () => {
      log.register({ address: 'K' }); log.register({ address: 'R' }); log.register({ address: 'S' }); log.mintChild('K');
      transport.enqueue({ ok: true, code: 'injected' });
      transport.enqueue({ ok: false, code: 'no-session', reason: 'gone' });
      transport.enqueue({ ok: true, code: 'injected' });
      const result = await post(newBroker(), 'K', '@all');
      expect(result).toMatchObject({ outcome: 'failed', code: 'partial' });
      expect(result.reason).toContain('1/3');
      expect(transport.calls.map((call) => call.target).sort()).toEqual(['K.1', 'R', 'S']);
      expect(log.deliveries({ messageId: accepted(result).messageId })).toHaveLength(3);
      expect(log.deliveries({ messageId: accepted(result).messageId }).some((d) => d.outcome === 'failed' && d.code === 'no-session')).toBe(true);
    });

    it('reports a broadcast that both failed and held as partial-mixed', async () => {
      log.register({ address: 'R' }); log.register({ address: 'S' }); log.mintChild('K');
      state.states.set('K.1', 'permission-gate');
      transport.enqueue({ ok: false, code: 'no-session' }); // first non-held recipient
      const result = await post(newBroker(), 'K', '@all');
      expect(result).toMatchObject({ outcome: 'failed', code: 'partial-mixed' });
      expect(result.reason).toMatch(/1\/3 recipients failed, 1\/3 held/);
    });

    it('logs a broadcast with no other recipients', async () => {
      const result = await post(newBroker(), 'K', '@all');
      expect(result).toMatchObject({ outcome: 'logged', code: 'no-recipients' });
      expect(transport.calls).toEqual([]);
      expect(log.deliveries()).toMatchObject([{ outcome: 'logged', code: 'no-recipients' }]);
    });
  });

  describe('transport outcomes', () => {
    it('records explicit transport failures, thrown errors, and normalized garbage codes', async () => {
      const broker = newBroker();
      transport.enqueue({ ok: false, code: 'no-session', reason: 'absent' });
      const noSession = await post(broker);
      transport.enqueue(new Error('socket closed'));
      const thrown = await post(broker, 'K', 'S');
      transport.enqueue({ ok: true, code: 'BAD CODE!!' });
      await post(broker, 'K', 'T');
      transport.enqueue({ ok: false, code: 'BAD CODE!!' });
      await post(broker, 'K', 'U');
      expect(noSession).toMatchObject({ outcome: 'failed', code: 'no-session', reason: 'absent' });
      expect(thrown).toMatchObject({ outcome: 'failed', code: 'transport-error', reason: 'socket closed' });
      expect(log.deliveries()).toMatchObject([
        { outcome: 'failed', code: 'no-session' },
        { outcome: 'failed', code: 'transport-error', reason: 'socket closed' },
        { outcome: 'sent', code: 'injected' },
        { outcome: 'failed', code: 'transport-error' },
      ]);
    });
  });

  describe('envelope integration', () => {
    it('stores directive and agent-message tiers and logs invalid enveloped messages as refusals', async () => {
      log.mintChild('K');
      const broker = newBroker();
      const directive = await post(broker, 'K', 'K.1');
      const agent = await post(broker, 'R', 'K.1');
      const invalid = await broker.post({ from: 'K', to: 'R', body: 'bad reply', replyTo: 999 });
      expect(directive).toMatchObject({ tier: 'orchestrator-directive' });
      expect(accepted(directive).envelope).toMatch(/^>>>heddle ORCHESTRATOR DIRECTIVE/);
      expect(agent).toMatchObject({ tier: 'agent-message' });
      expect(invalid).toMatchObject({ outcome: 'refused', code: 'invalid-message' });
      expect(log.deliveries().at(-1)).toMatchObject({ outcome: 'refused', code: 'invalid-message', messageId: null });
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
