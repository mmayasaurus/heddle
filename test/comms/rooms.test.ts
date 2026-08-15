import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommsLog, DEFAULT_FLOOR_LEASE_MS, DEFAULT_ROOM } from '../../src/comms/log.js';
import { Broker, type BrokerOptions, type PostResult, type Transport, type Delivery, type TransportOutcome } from '../../src/comms/broker.js';
import { ChannelTransport } from '../../src/comms/bridge.js';

class FakeTransport implements Transport {
  readonly name = 'fake';
  calls: Delivery[] = [];
  async deliver(delivery: Delivery): Promise<TransportOutcome> {
    this.calls.push(delivery);
    return { ok: true, code: 'injected' };
  }
}

const channelTransport = (log: CommsLog): Transport => new ChannelTransport(log);

describe('rooms (temp db)', () => {
  let dir: string;
  let log: CommsLog;
  let transport: FakeTransport;
  let nowMs: number;
  const clock = () => new Date(nowMs).toISOString();
  const now = () => Date.parse(clock());
  const advance = (ms: number) => { nowMs += ms; };
  const newBroker = (over: Partial<BrokerOptions> = {}) => new Broker({ log, transport, now, ...over });
  const accepted = (result: PostResult): Exclude<PostResult, { outcome: 'refused' }> => {
    if (result.outcome === 'refused') throw new Error(`expected an accepted post, got ${result.code}`);
    return result;
  };
  const expectGovernanceRefusal = (result: unknown, actor: string, room: string) => {
    expect(result).toMatchObject({ outcome: 'refused', code: 'room-governance', to: room });
    expect(log.deliveries().at(-1)).toMatchObject({
      messageId: null, from: actor, to: room, outcome: 'refused', code: 'room-governance',
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-rooms-test-'));
    nowMs = Date.UTC(2026, 7, 15, 12, 0, 0);
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    transport = new FakeTransport();
  });
  afterEach(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates idempotent named rooms, validates creators, and ensures sorted default rooms', () => {
    const made = log.createRoom({ name: '#zeta', by: 'K', topic: 'topic', open: true });
    expect(made).toEqual({ name: '#zeta', createdBy: 'K', createdAt: clock(), topic: 'topic', open: true });
    advance(1);
    expect(log.createRoom({ name: '#zeta', by: 'R', topic: 'changed', open: false })).toEqual(made);
    expect(() => log.createRoom({ name: 'zeta', by: 'K' })).toThrow(/rooms are #names/);
    expect(() => log.createRoom({ name: '#bad', by: '#fleet' })).toThrow(/agent or the operator/);
    expect(() => log.createRoom({ name: '#bad', by: '@all' })).toThrow(/agent or the operator/);
    const defaults = log.ensureDefaultRooms();
    expect(defaults).toEqual([expect.objectContaining({ name: DEFAULT_ROOM, createdBy: 'operator', open: true })]);
    expect(log.ensureDefaultRooms()).toEqual(defaults);
    expect(log.rooms().map((room) => room.name)).toEqual(['#fleet', '#zeta']);
  });

  it('keeps first membership data, validates members, and lists rooms a participant may use', () => {
    log.createRoom({ name: '#open', by: 'operator', open: true });
    log.createRoom({ name: '#closed', by: 'operator' });
    const first = log.addMember({ room: '#closed', address: 'K', by: 'operator' });
    advance(1);
    expect(log.addMember({ room: '#closed', address: 'K', by: 'R' })).toEqual(first);
    expect(log.member('#closed', 'K')).toEqual(first);
    expect(log.members('#closed')).toEqual([first]);
    expect(() => log.addMember({ room: '#missing', address: 'K', by: 'operator' })).toThrow(/no such room/);
    expect(() => log.addMember({ room: '#closed', address: '#x', by: 'operator' })).toThrow(/members are agents/);
    expect(() => log.addMember({ room: '#closed', address: '@all', by: 'operator' })).toThrow(/members are agents/);
    expect(log.roomsFor('K').map((room) => room.name)).toEqual(['#closed', '#open']);
    expect(log.roomsFor('R').map((room) => room.name)).toEqual(['#open']);
    expect(log.roomsFor('operator').map((room) => room.name)).toEqual(['#closed', '#open']);
    expect(log.removeMember('#closed', 'K')).toBe(true);
    expect(log.removeMember('#closed', 'K')).toBe(false);
  });

  it('leases, renews, expires, and releases room floors', () => {
    log.createRoom({ name: '#hed-73', by: 'K' });
    const first = log.acquireFloor('#hed-73', 'K');
    expect(first).toEqual({ room: '#hed-73', holder: 'K', since: clock(), expiresAt: new Date(now() + DEFAULT_FLOOR_LEASE_MS).toISOString() });
    expect(log.acquireFloor('#hed-73', 'R')).toBeNull();
    advance(10);
    const renewed = log.acquireFloor('#hed-73', 'K')!;
    expect(renewed).toMatchObject({ holder: 'K', since: first!.since, expiresAt: new Date(now() + DEFAULT_FLOOR_LEASE_MS).toISOString() });
    advance(DEFAULT_FLOOR_LEASE_MS + 1);
    expect(log.floor('#hed-73')).toBeNull();
    expect(log.acquireFloor('#hed-73', 'R')).toMatchObject({ holder: 'R' });
    expect(log.releaseFloor('#hed-73', 'K')).toBe(false);
    expect(log.releaseFloor('#hed-73', 'R')).toBe(true);
    expect(() => log.acquireFloor('#missing', 'K')).toThrow(/no such room/);
    expect(() => log.acquireFloor('#hed-73', 'K', 0)).toThrow(/positive/);
  });

  it('governs room creation for operators and fleet agents, and ledgers refusals', () => {
    const broker = newBroker();
    expect(broker.createRoom('K', '#hed-73')).toEqual({ room: expect.objectContaining({ name: '#hed-73', createdBy: 'K', open: false }) });
    expect(broker.createRoom('operator', '#open', { open: true })).toEqual({ room: expect.objectContaining({ name: '#open', open: true }) });
    log.mintChild('K');
    expectGovernanceRefusal(broker.createRoom('K.1', '#child'), 'K.1', '#child');
    expectGovernanceRefusal(broker.createRoom('K', 'fleet'), 'K', 'fleet');
  });

  it('governs membership changes and permits self-removal', () => {
    const broker = newBroker();
    broker.createRoom('K', '#hed-73');
    log.mintChild('K');
    log.mintChild('R');
    expect(broker.addMember('K', '#hed-73', 'K')).toEqual({ member: expect.objectContaining({ address: 'K', addedBy: 'K' }) });
    expect(broker.addMember('K', '#hed-73', 'R')).toEqual({ member: expect.objectContaining({ address: 'R' }) });
    expect(broker.addMember('K', '#hed-73', 'K.1')).toEqual({ member: expect.objectContaining({ address: 'K.1' }) });
    expectGovernanceRefusal(broker.addMember('K', '#hed-73', 'R.1'), 'K', '#hed-73');
    expectGovernanceRefusal(broker.addMember('K.1', '#hed-73', 'K.1'), 'K.1', '#hed-73');
    expect(broker.addMember('operator', '#hed-73', 'R.1')).toEqual({ member: expect.objectContaining({ address: 'R.1' }) });
    expectGovernanceRefusal(broker.addMember('K', '#missing', 'K'), 'K', '#missing');
    expect(broker.removeMember('K.1', '#hed-73', 'K.1')).toEqual({ removed: true });
    expectGovernanceRefusal(broker.removeMember('K.1', '#hed-73', 'R'), 'K.1', '#hed-73');
    // Removal mirrors addition: an orchestrator may remove itself or its OWN children, never a peer; the operator anyone.
    expectGovernanceRefusal(broker.removeMember('K', '#hed-73', 'R'), 'K', '#hed-73');
    broker.addMember('K', '#hed-73', 'K.1'); // (K.1 left itself above)
    expect(broker.removeMember('K', '#hed-73', 'K.1')).toEqual({ removed: true });
    expect(broker.removeMember('operator', '#hed-73', 'R')).toEqual({ removed: true });
    expect(broker.removeMember('operator', '#hed-73', 'R.1')).toEqual({ removed: true });
    // A missing room is a no-such-room refusal, like every other room op.
    expect(broker.removeMember('K', '#nope', 'K')).toMatchObject({ outcome: 'refused', code: 'no-such-room' });
    expect(broker.releaseFloor('K', '#nope')).toMatchObject({ outcome: 'refused', code: 'no-such-room' });
  });

  it('enforces room existence and membership while allowing operator room posts', async () => {
    const broker = newBroker();
    expect(await broker.post({ from: 'K', to: '#missing', body: 'nope' })).toMatchObject({ outcome: 'refused', code: 'no-such-room' });
    expect(log.count()).toBe(0);
    expect(log.deliveries().at(-1)).toMatchObject({ messageId: null, outcome: 'refused', code: 'no-such-room' });
    log.ensureDefaultRooms();
    log.register({ address: 'K' }); log.register({ address: 'R' }); log.mintChild('K');
    for (const from of ['K', 'R', 'K.1']) {
      expect(await broker.post({ from, to: '#fleet', body: from })).toMatchObject({ outcome: 'logged', code: 'room-pull' });
    }
    broker.createRoom('K', '#hed-73');
    expect(await broker.post({ from: 'R', to: '#hed-73', body: 'blocked' })).toMatchObject({ outcome: 'refused', code: 'not-a-member' });
    broker.addMember('K', '#hed-73', 'K');
    expect(await broker.post({ from: 'K', to: '#hed-73', body: 'allowed' })).toMatchObject({ outcome: 'logged', code: 'room-pull' });
    const operator = accepted(await broker.post({ from: 'operator', to: '#hed-73', body: 'authority' }));
    expect(log.get(operator.messageId)).toMatchObject({ tier: 'operator', verified: true });
  });

  it('holds the room floor across multipart posts and returns floor-held refusals', async () => {
    log.ensureDefaultRooms();
    const broker = newBroker();
    expect(await broker.post({ from: 'K', to: '#fleet', body: 'part 1', holdFloor: true })).toMatchObject({ outcome: 'logged' });
    expect(log.floor('#fleet')).toMatchObject({ holder: 'K' });
    const blocked = await broker.post({ from: 'R', to: '#fleet', body: 'interleave' });
    expect(blocked).toMatchObject({ outcome: 'refused', code: 'floor-held' });
    expect((blocked as Extract<PostResult, { outcome: 'refused' }>).retryAfterMs).toBeGreaterThan(0);
    expect(log.deliveries().at(-1)).toMatchObject({ messageId: null, outcome: 'refused', code: 'floor-held' });
    const beforeRenewal = log.floor('#fleet')!;
    advance(1_001);
    await broker.post({ from: 'K', to: '#fleet', body: 'part 2' });
    expect(Date.parse(log.floor('#fleet')!.expiresAt)).toBeGreaterThan(Date.parse(beforeRenewal.expiresAt));
    expect(await broker.post({ from: 'K', to: '#fleet', body: 'done', releaseFloor: true })).toMatchObject({ outcome: 'logged' });
    expect(log.floor('#fleet')).toBeNull();
    expect(await broker.post({ from: 'R', to: '#fleet', body: 'now mine' })).toMatchObject({ outcome: 'logged' });
    advance(1_001);
    await broker.post({ from: 'K', to: '#fleet', body: 'new floor', holdFloor: true });
    expect(broker.acquireFloor('R', '#fleet')).toMatchObject({ outcome: 'refused', code: 'floor-held' });
    expect(broker.releaseFloor('R', '#fleet')).toEqual({ released: false });
    advance(DEFAULT_FLOOR_LEASE_MS + 1);
    expect(await broker.post({ from: 'R', to: '#fleet', body: 'after expiry' })).toMatchObject({ outcome: 'logged' });
  });

  it('broadcasts to live sessions and durable inboxes with ChannelTransport', async () => {
    log.register({ address: 'R' });
    log.registerSession({ address: 'R', sessionId: 'r-live' });
    log.register({ address: 'S' });
    log.mintChild('K');
    const broker = newBroker({ transport: channelTransport(log) });
    const sent = accepted(await broker.post({ from: 'K', to: '@all', body: 'announcement' }));
    expect(sent).toMatchObject({ outcome: 'sent', code: 'broadcast', reason: '1/3 pushed, 2/3 to inbox' });
    expect(log.deliveries({ messageId: sent.messageId }).map((d) => [d.to, d.outcome, d.code]).sort())
      .toEqual([['K.1', 'logged', 'inbox'], ['R', 'sent', 'queued-for-channel'], ['S', 'logged', 'inbox']]);
    expect(log.deliveries({ messageId: sent.messageId }).some((delivery) => delivery.to === 'K')).toBe(false);
    const fresh = new CommsLog(join(dir, 'empty.db'), { now: clock });
    const none = accepted(await new Broker({ log: fresh, transport: channelTransport(fresh), now }).post({ from: 'Z', to: '@all', body: 'alone' }));
    expect(none).toMatchObject({ outcome: 'logged', code: 'no-recipients' });
    fresh.close();
  });

  it('lets the operator bypass membership but not an active room floor', async () => {
    log.ensureDefaultRooms();
    const broker = newBroker();
    const fleet = accepted(await broker.post({ from: 'operator', to: '#fleet', body: 'fleet' }));
    const broadcast = accepted(await broker.post({ from: 'operator', to: '@all', body: 'all' }));
    expect([log.get(fleet.messageId), log.get(broadcast.messageId)]).toEqual([
      expect.objectContaining({ tier: 'operator', verified: true }),
      expect.objectContaining({ tier: 'operator', verified: true }),
    ]);
    broker.createRoom('K', '#closed');
    broker.addMember('K', '#closed', 'K');
    await broker.post({ from: 'K', to: '#closed', body: 'holding', holdFloor: true });
    expect(await broker.post({ from: 'operator', to: '#closed', body: 'blocked by floor' }))
      .toMatchObject({ outcome: 'refused', code: 'floor-held' });
    advance(DEFAULT_FLOOR_LEASE_MS + 1);
    const closed = accepted(await broker.post({ from: 'operator', to: '#closed', body: 'membership bypass' }));
    expect(log.get(closed.messageId)).toMatchObject({ tier: 'operator', verified: true });
  });
});
