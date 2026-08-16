import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CommsLog } from '../../src/comms/log.js';
import { Broker, type BrokerOptions, type Delivery, type PostResult, type TargetState, type TargetStateProvider, type Transport, type TransportOutcome } from '../../src/comms/broker.js';
import { ChannelTransport, InboundPump, type ChannelEvent } from '../../src/comms/bridge.js';

class FakeTransport implements Transport {
  readonly name = 'fake';
  calls: Delivery[] = [];
  async deliver(delivery: Delivery): Promise<TransportOutcome> {
    this.calls.push(delivery);
    return { ok: true, code: 'injected' };
  }
}

class FakeState implements TargetStateProvider {
  states = new Map<string, TargetState>();
  state(address: string): TargetState { return this.states.get(address) ?? 'unknown'; }
}

const channelTransport = (log: CommsLog): Transport => new ChannelTransport(log);

describe('mentions (temp db)', () => {
  let dir: string;
  let log: CommsLog;
  let transport: FakeTransport;
  let state: FakeState;
  let nowMs: number;
  const clock = () => new Date(nowMs).toISOString();
  const now = () => Date.parse(clock());
  const advance = (ms: number) => { nowMs += ms; };
  const newBroker = (over: Partial<BrokerOptions> = {}) => new Broker({ log, transport, targetState: state, now, ...over });
  const accepted = (result: PostResult): Exclude<PostResult, { outcome: 'refused' }> => {
    if (result.outcome === 'refused') throw new Error(`expected an accepted post, got ${result.code}`);
    return result;
  };
  const expectMentionRefusal = (result: PostResult, code: string) => {
    expect(result).toMatchObject({ outcome: 'refused', code });
    expect(log.count()).toBe(0);
    expect(log.deliveries().at(-1)).toMatchObject({ messageId: null, outcome: 'refused', code });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-mentions-test-'));
    nowMs = Date.UTC(2026, 7, 15, 12, 0, 0);
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    transport = new FakeTransport();
    state = new FakeState();
  });
  afterEach(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores ordered mention rows append-only and returns an empty list without mentions', () => {
    const mentioned = log.append({ from: 'K', to: '#fleet', body: 'ping', mentions: ['R', 'S'] });
    const plain = log.append({ from: 'K', to: '#fleet', body: 'plain' });
    expect(mentioned.mentions).toEqual(['R', 'S']);
    expect(plain.mentions).toEqual([]);
    const raw = new DatabaseSync(join(dir, 'comms.db'));
    expect(raw.prepare('SELECT message_id, address FROM message_mentions ORDER BY rowid').all()).toEqual([
      { message_id: mentioned.id, address: 'R' }, { message_id: mentioned.id, address: 'S' },
    ]);
    expect(() => raw.prepare('UPDATE message_mentions SET address = ? WHERE message_id = ?').run('T', mentioned.id)).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM message_mentions WHERE message_id = ?').run(mentioned.id)).toThrow(/append-only/);
    raw.close();
  });

  it('validates mention grammar and preserves mentions through get and transcript', () => {
    expect(() => log.append({ from: 'K', to: '#fleet', body: 'many', mentions: Array.from({ length: 17 }, (_, i) => `R${i}`) })).toThrow(/at most 16/);
    expect(() => log.append({ from: 'K', to: '#fleet', body: 'duplicate', mentions: ['R', 'R'] })).toThrow(/duplicate mention/);
    expect(() => log.append({ from: 'K', to: '#fleet', body: 'room', mentions: ['#fleet'] })).toThrow(/agent\/child\/operator/);
    expect(() => log.append({ from: 'K', to: '#fleet', body: 'broadcast', mentions: ['@all'] })).toThrow(/agent\/child\/operator/);
    const record = log.append({ from: 'K', to: '#fleet', body: 'durable', mentions: ['R', 'S'] });
    expect(log.get(record.id)?.mentions).toEqual(['R', 'S']);
    expect(log.transcript({ room: '#fleet' })).toEqual([expect.objectContaining({ id: record.id, mentions: ['R', 'S'] })]);
  });

  it("includes only a recipient's mentioned room posts in its inbox across log handles", () => {
    log.ensureDefaultRooms();
    const direct = log.append({ from: 'K', to: 'R', body: 'direct' });
    const broadcast = log.append({ from: 'K', to: '@all', body: 'all' });
    const mentioned = log.append({ from: 'K', to: '#fleet', body: 'for R', mentions: ['R'] });
    const unmentioned = log.append({ from: 'K', to: '#fleet', body: 'not for R', mentions: ['S'] });
    const expected = [direct.id, broadcast.id, mentioned.id];
    expect(log.transcript({ inbox: 'R' }).map((r) => r.id)).toEqual(expected);
    const second = new CommsLog(join(dir, 'comms.db'), { now: clock });
    expect(second.transcript({ inbox: 'R' }).map((r) => r.id)).toEqual(expected);
    expect(second.transcript({ inbox: 'R' }).map((r) => r.id)).not.toContain(unmentioned.id);
    second.close();
  });

  it('refuses mentions on a DM and records the refusal without a message', async () => {
    expectMentionRefusal(await newBroker().post({ from: 'K', to: 'R', body: 'no', mentions: ['S'] }), 'mention-outside-room');
  });

  it('refuses unknown and reserved mentions and records each refusal without a message', async () => {
    log.ensureDefaultRooms();
    expectMentionRefusal(await newBroker().post({ from: 'K', to: '#fleet', body: 'unknown', mentions: ['R'] }), 'unknown-mention');
    expectMentionRefusal(await newBroker().post({ from: 'K', to: '#fleet', body: 'reserved', mentions: ['peer'] }), 'unknown-mention');
  });

  it('enforces closed-room membership for mentions while allowing the operator in an open room', async () => {
    const broker = newBroker();
    broker.createRoom('K', '#closed');
    log.register({ address: 'R' });
    broker.addMember('K', '#closed', 'K');
    expectMentionRefusal(await broker.post({ from: 'K', to: '#closed', body: 'blocked', mentions: ['R'] }), 'mention-not-member');
    broker.addMember('K', '#closed', 'R');
    expect(await broker.post({ from: 'K', to: '#closed', body: 'allowed', mentions: ['R'] })).toMatchObject({ outcome: 'logged', code: 'room-pull' });
    log.ensureDefaultRooms();
    expect(await broker.post({ from: 'K', to: '#fleet', body: 'operator', mentions: ['operator'] })).toMatchObject({ outcome: 'logged', code: 'room-pull' });
  });

  it('drops self-mentions and deduplicates broker requests before log validation', async () => {
    log.ensureDefaultRooms();
    log.register({ address: 'R' });
    const broker = newBroker();
    const self = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'self', mentions: ['K'] }));
    expect(log.get(self.messageId)?.mentions).toEqual([]);
    expect(log.deliveries({ messageId: self.messageId }).some((d) => d.to === 'K')).toBe(false);
    const duplicate = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'once', mentions: ['R', 'R'] }));
    expect(log.get(duplicate.messageId)?.mentions).toEqual(['R']);
    expect(log.deliveries({ messageId: duplicate.messageId }).filter((d) => d.to === 'R')).toHaveLength(1);
  });

  it('fans out mentions to live sessions and inboxes without delivering to unmentioned members', async () => {
    log.ensureDefaultRooms();
    log.register({ address: 'R' }); log.register({ address: 'S' }); log.register({ address: 'T' });
    log.registerSession({ address: 'R', sessionId: 'r-live' });
    const broker = newBroker({ transport: channelTransport(log) });
    const result = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'ping', mentions: ['R', 'S'] }));
    expect(result).toMatchObject({ outcome: 'logged', code: 'room-pull' });
    expect(result.reason).toContain('mentions: 1/2 pushed, 1/2 to inbox');
    expect(log.deliveries({ messageId: result.messageId }).map((d) => [d.to, d.outcome, d.code]).sort()).toEqual([
      ['#fleet', 'logged', 'room-pull'], ['R', 'sent', 'queued-for-channel'], ['S', 'logged', 'inbox'],
    ]);
    expect(log.deliveries({ messageId: result.messageId }).some((d) => d.to === 'T')).toBe(false);
  });

  it('charges room and mention pair budgets independently', async () => {
    log.ensureDefaultRooms();
    log.register({ address: 'R' });
    const broker = newBroker({ rateLimit: { max: 2, burst: 2 } });
    expect(await broker.post({ from: 'K', to: '#fleet', body: 'ping', mentions: ['R'] })).toMatchObject({ outcome: 'logged', code: 'room-pull' });
    expect(await broker.post({ from: 'K', to: 'R', body: 'direct' })).toMatchObject({ outcome: 'sent' });
    expect(await broker.post({ from: 'K', to: 'R', body: 'limited' })).toMatchObject({ outcome: 'refused', code: 'rate-limited' });
  });

  it('holds a mentioned member at a permission gate then releases or leaves it in the inbox at timeout', async () => {
    log.ensureDefaultRooms();
    log.register({ address: 'R' });
    log.registerSession({ address: 'R' });
    state.states.set('R', 'permission-gate');
    const broker = newBroker({ transport: channelTransport(log), holdMaxMs: 1000 });
    const held = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'held', mentions: ['R'] }));
    expect(log.deliveries({ messageId: held.messageId }).at(-1)).toMatchObject({ to: 'R', outcome: 'held', code: 'permission-gate' });
    state.states.set('R', 'idle');
    expect(await broker.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 });
    expect(log.deliveries({ messageId: held.messageId }).at(-1)).toMatchObject({ to: 'R', outcome: 'released', code: 'gate-cleared' });
    state.states.set('R', 'permission-gate');
    const timeout = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'timeout', mentions: ['R'] }));
    advance(1001);
    expect(await broker.pump()).toEqual({ released: 1, failed: 0, stillHeld: 0 });
    expect(log.deliveries({ messageId: timeout.messageId }).at(-1)).toMatchObject({ to: 'R', outcome: 'logged', code: 'inbox' });
  });

  it('pumps a mentioned room post once with channel metadata and records the channel write', async () => {
    log.ensureDefaultRooms();
    log.register({ address: 'R' });
    const broker = newBroker({ transport: channelTransport(log) });
    await broker.post({ from: 'K', to: '#fleet', body: 'not for R', mentions: [] });
    const mentioned = accepted(await broker.post({ from: 'K', to: '#fleet', body: 'for R', mentions: ['R'] }));
    const events: Array<{ event: ChannelEvent; id: number }> = [];
    const pump = new InboundPump(log, 'R', (event, record) => { events.push({ event, id: record.id }); }, { sinceId: 0 });
    expect(await pump.tick()).toEqual({ emitted: 1, failed: 0 });
    expect(await pump.tick()).toEqual({ emitted: 0, failed: 0 });
    expect(events).toEqual([{
      id: mentioned.messageId,
      event: expect.objectContaining({ content: 'for R', meta: expect.objectContaining({ mention: '1', room: 'fleet', sender: 'K', tier: 'agent-message' }) }),
    }]);
    expect(Object.keys(events[0].event.meta).every((key) => /^[a-z0-9_]+$/.test(key))).toBe(true);
    expect(log.deliveries({ messageId: mentioned.messageId }).at(-1)).toMatchObject({ to: 'R', outcome: 'sent', code: 'channel-written' });
  });
});
