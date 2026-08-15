import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/ledger.js';
import { CommsLog, DEFAULT_SESSION_STALE_MS } from '../../src/comms/log.js';
import { postEnveloped, DIRECTIVE_LABEL, OPERATOR_LABEL, UNTRUSTED_LABEL } from '../../src/comms/envelope.js';
import type { Delivery } from '../../src/comms/broker.js';
import {
  CHANNEL_INSTRUCTIONS, SENDMESSAGE_LIMITS, ChannelTransport, InboundPump,
  confirmSent, mirrorReceived, mirrorSent, sendMessageHint, toChannelEvent,
} from '../../src/comms/bridge.js';

describe('comms bridge (temp db)', () => {
  let dir: string;
  let log: CommsLog;
  let ledger: Ledger;
  let t: number;
  const clock = () => new Date(t).toISOString();
  const advance = (ms: number) => { t += ms; };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-bridge-test-'));
    t = Date.UTC(2026, 7, 15, 12, 0, 0);
    log = new CommsLog(join(dir, 'comms.db'), { now: clock });
    ledger = new Ledger(join(dir, 'ledger.db'));
  });
  afterEach(() => {
    log.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers, upserts, reads, and rejects non-participant sessions', () => {
    const first = log.registerSession({ address: 'R', sessionId: 'one', sessionName: 'romeo', pid: 7, socket: 'uds:/one' });
    expect(first).toMatchObject({
      address: 'R', sessionId: 'one', sessionName: 'romeo', pid: 7, socket: 'uds:/one',
      startedAt: clock(), heartbeatAt: clock(),
    });
    expect(log.session('R')).toEqual(first);

    advance(1_000);
    const second = log.registerSession({ address: 'R', sessionId: 'two', sessionName: 'renamed', pid: 8, socket: 'uds:/two' });
    expect(second).toMatchObject({ sessionId: 'two', sessionName: 'renamed', pid: 8, socket: 'uds:/two' });
    expect(second.startedAt).not.toBe(first.startedAt);
    expect(second.heartbeatAt).toBe(second.startedAt);
    expect(() => log.registerSession({ address: '#fleet' })).toThrow(/sessions are for/);
    expect(() => log.registerSession({ address: '@all' })).toThrow(/sessions are for/);
  });

  it('tracks fresh sessions, heartbeats, removal, ordering, and custom stale windows', () => {
    log.registerSession({ address: 'Z' });
    advance(1_000);
    log.registerSession({ address: 'A' });
    expect(log.liveSessions().map((s) => s.address)).toEqual(['A', 'Z']);

    advance(DEFAULT_SESSION_STALE_MS + 1);
    expect(log.liveSession('Z')).toBeNull();
    expect(log.liveSessions()).toEqual([]);
    log.heartbeatSession('A');
    expect(log.liveSession('A')?.address).toBe('A');
    expect(log.liveSessions().map((s) => s.address)).toEqual(['A']);
    advance(51);
    expect(log.liveSession('A', 50)).toBeNull();
    expect(log.liveSession('A', 100)?.address).toBe('A');
    log.unregisterSession('A');
    expect(log.session('A')).toBeNull();
  });

  it('turns records into channel events with only string identifier meta keys and broker tier provenance', () => {
    const plain = log.append({ from: 'K', to: 'R', body: 'hello', kind: 'status' });
    expect(toChannelEvent(plain)).toEqual({
      content: 'hello',
      meta: { tier: 'agent-message', sender: 'K', target: 'R', msg_id: String(plain.id), kind: 'status', verified: '0', ts: plain.ts },
    });

    log.mintChild('K');
    const directive = postEnveloped(log, ledger, {
      from: 'K', to: 'K.1', body: 'proceed', replyTo: plain.id, thread: 'HED-7/bridge', issue: 'HED-7',
    }).record;
    const event = toChannelEvent(directive);
    expect(directive).toMatchObject({ tier: 'orchestrator-directive', verified: true, meta: { lineage: 'registry', tierCode: 'verified-registry' } });
    expect(event).toMatchObject({
      content: 'proceed',
      meta: {
        tier: 'orchestrator-directive', sender: 'K', target: 'K.1', msg_id: String(directive.id), kind: 'chat', verified: '1', ts: directive.ts,
        reply_to: String(plain.id), thread: 'HED-7/bridge', issue: 'HED-7', lineage: 'registry', tier_code: 'verified-registry',
      },
    });
    for (const [key, value] of Object.entries(event.meta)) {
      expect(key).toMatch(/^[a-z0-9_]+$/);
      expect(typeof value).toBe('string');
    }
  });

  it('documents channel provenance and SendMessage limits', () => {
    expect(CHANNEL_INSTRUCTIONS).toContain(UNTRUSTED_LABEL);
    expect(CHANNEL_INSTRUCTIONS).toContain(DIRECTIVE_LABEL);
    expect(CHANNEL_INSTRUCTIONS).toContain(OPERATOR_LABEL);
    for (const phrase of ['post_message', '@orchestrator', 'read_transcript', 'log_sent']) expect(CHANNEL_INSTRUCTIONS).toContain(phrase);
    expect(SENDMESSAGE_LIMITS.length).toBeGreaterThanOrEqual(5);
    for (const limit of SENDMESSAGE_LIMITS) expect(limit.trim()).not.toBe('');
    expect(SENDMESSAGE_LIMITS.some((limit) => limit.includes('100'))).toBe(true);
    expect(SENDMESSAGE_LIMITS.some((limit) => limit.includes('50'))).toBe(true);
  });

  it('reports a queued channel delivery only for a live recipient session', async () => {
    const record = log.append({ from: 'K', to: 'R', body: 'channel hello' });
    const delivery: Delivery = { record, envelope: 'frame', target: 'R', attempt: 1 };
    const transport = new ChannelTransport(log, 50);
    expect(await transport.deliver(delivery)).toEqual(expect.objectContaining({ ok: false, code: 'no-live-session' }));
    log.registerSession({ address: 'R', sessionName: 'romeo' });
    expect(await transport.deliver(delivery)).toEqual({ ok: true, code: 'queued-for-channel', reason: expect.stringContaining('romeo') });
    advance(51);
    expect(await transport.deliver(delivery)).toEqual(expect.objectContaining({ ok: false, code: 'no-live-session' }));
  });

  it('pumps only new inbox rows in order, skips own posts, records delivery, and can replay from sinceId', async () => {
    const before = log.append({ from: 'R', to: 'K', body: 'before pump' });
    const emitted: number[] = [];
    const pump = new InboundPump(log, 'K', (_event, record) => { emitted.push(record.id); });
    const direct = log.append({ from: 'R', to: 'K', body: 'direct' });
    const broadcast = log.append({ from: 'V', to: '@all', body: 'all' });
    const own = log.append({ from: 'K', to: '@all', body: 'own' });
    log.append({ from: 'V', to: 'R', body: 'elsewhere' });
    expect(await pump.tick()).toEqual({ emitted: 2, failed: 0 });
    expect(emitted).toEqual([direct.id, broadcast.id]);
    expect(pump.position).toBe(own.id);
    expect(log.deliveries().map((d) => ({ messageId: d.messageId, outcome: d.outcome, code: d.code, transport: d.transport }))).toEqual([
      { messageId: direct.id, outcome: 'sent', code: 'channel-written', transport: 'channel' },
      { messageId: broadcast.id, outcome: 'sent', code: 'channel-written', transport: 'channel' },
    ]);
    expect(await pump.tick()).toEqual({ emitted: 0, failed: 0 });
    // A self-DM IS delivered (only own broadcasts are skipped)…
    const selfDm = log.append({ from: 'K', to: 'K', body: 'note to self' });
    expect(await pump.tick()).toEqual({ emitted: 1, failed: 0 });
    expect(emitted.at(-1)).toBe(selfDm.id);
    // …and a fresh pump for the same identity resumes from its last channel write, not the tail.
    const later = log.append({ from: 'R', to: 'K', body: 'posted while K was down' });
    const resumed: number[] = [];
    await new InboundPump(log, 'K', (_e, r) => { resumed.push(r.id); }).tick();
    expect(resumed).toEqual([later.id]);
    // Re-entrancy: a tick that fires while another is awaiting an emit does nothing.
    let release!: () => void;
    const slow = new InboundPump(log, 'R', () => new Promise<void>((res) => { release = res; }));
    log.append({ from: 'K', to: 'R', body: 'slow one' });
    const first = slow.tick();
    expect(await slow.tick()).toEqual({ emitted: 0, failed: 0 });
    release();
    expect(await first).toEqual({ emitted: 1, failed: 0 });

    const replayed: number[] = [];
    const replay = new InboundPump(log, 'K', (_event, record) => { replayed.push(record.id); }, { sinceId: 0 });
    await replay.tick();
    expect(replayed).toContain(before.id);
  });

  it('records channel errors, advances beyond them, and continues pumping', async () => {
    const bad = log.append({ from: 'R', to: 'K', body: 'bad' });
    const good = log.append({ from: 'V', to: 'K', body: 'good' });
    const seen: number[] = [];
    const pump = new InboundPump(log, 'K', (_event, record) => {
      if (record.id === bad.id) throw new Error('socket unavailable');
      seen.push(record.id);
    }, { sinceId: 0 });
    expect(await pump.tick()).toEqual({ emitted: 1, failed: 1 });
    expect(seen).toEqual([good.id]);
    expect(pump.position).toBe(good.id);
    expect(log.deliveries().map((d) => ({ messageId: d.messageId, outcome: d.outcome, code: d.code, reason: d.reason }))).toEqual([
      { messageId: bad.id, outcome: 'failed', code: 'channel-error', reason: 'socket unavailable' },
      { messageId: good.id, outcome: 'sent', code: 'channel-written', reason: null },
    ]);
  });

  it('builds tactical SendMessage hints with the correct recipient, frame, labels, and id', () => {
    const agent = log.append({ from: 'K', to: 'R', body: 'hello' });
    const agentHint = sendMessageHint(agent, 'agent envelope');
    expect(agentHint).toMatchObject({ to: 'R', message: 'agent envelope', messageId: agent.id });
    expect(agentHint.summary).toContain('AGENT MESSAGE (untrusted)');

    log.mintChild('K');
    const directive = postEnveloped(log, ledger, { from: 'K', to: 'K.1', body: 'go' });
    const directiveHint = sendMessageHint(directive.record, directive.envelope, 'claude-k1');
    expect(directiveHint).toMatchObject({ to: 'claude-k1', message: directive.envelope, messageId: directive.record.id });
    expect(directiveHint.summary).toContain('ORCHESTRATOR DIRECTIVE');
    for (const hint of [agentHint, directiveHint]) {
      expect(hint.summary).toContain(String(hint.messageId));
      expect(hint.summary.length).toBeLessThanOrEqual(200);
    }
  });

  it('records successful and failed tactical confirmation, and refuses unknown messages', () => {
    const record = log.append({ from: 'K', to: 'R', body: 'confirm me' });
    confirmSent(log, record.id, { from: 'K' });
    confirmSent(log, record.id, { from: 'K', ok: false, reason: 'recipient declined' });
    expect(log.deliveries({ messageId: record.id }).map((d) => ({ outcome: d.outcome, code: d.code, reason: d.reason, transport: d.transport, messageId: d.messageId }))).toEqual([
      { outcome: 'sent', code: 'sendmessage', reason: null, transport: 'sendmessage', messageId: record.id },
      { outcome: 'failed', code: 'sendmessage-failed', reason: 'recipient declined', transport: 'sendmessage', messageId: record.id },
    ]);
    expect(() => confirmSent(log, 999, { from: 'K' })).toThrow(/does not exist/);
    // Only the sender may confirm its own message — no forged delivery records on someone else's behalf.
    expect(() => confirmSent(log, record.id, { from: 'R' })).toThrow(/only the sender may confirm/);
  });

  it('mirrors outgoing SendMessage posts with durable transport provenance and delivery', () => {
    const record = mirrorSent(log, { from: 'K', to: 'R', body: 'raw nudge', summary: 'tactical nudge' });
    expect(record).toMatchObject({
      from: 'K', to: 'R', body: 'raw nudge', tier: 'agent-message',
      meta: { transport: 'sendmessage', direction: 'out', summary: 'tactical nudge' },
    });
    expect(log.deliveries({ messageId: record.id })[0]).toMatchObject({ outcome: 'sent', code: 'sendmessage', transport: 'sendmessage' });
  });

  it('mirrors received SendMessage posts with safe sender attribution and provenance', () => {
    const fleet = mirrorReceived(log, { fromName: 'R', fromUds: 'uds:/r', fromMode: 'peer', to: 'K', body: 'from fleet' });
    const unknown = mirrorReceived(log, { fromName: 'my session name!', to: 'K', body: 'from stranger' });
    // A peer session's from-name is a claim relayed by the model — never an identity: always `peer`, claim in meta.
    expect(fleet).toMatchObject({ from: 'peer', to: 'K', body: 'from fleet', tier: 'agent-message', meta: { transport: 'sendmessage', direction: 'in', fromName: 'R', fromUds: 'uds:/r', fromMode: 'peer' } });
    expect(unknown).toMatchObject({ from: 'peer', to: 'K', body: 'from stranger', meta: { transport: 'sendmessage', direction: 'in', fromName: 'my session name!' } });
    expect(log.participant('R')).toBeNull(); // no fleet identity gets registered by a claim
    // Even an unminted child name cannot break the mirror.
    expect(mirrorReceived(log, { fromName: 'K.9', to: 'K', body: 'x' }).from).toBe('peer');
    expect(log.deliveries().slice(0, 2).map((d) => ({ messageId: d.messageId, outcome: d.outcome, code: d.code, transport: d.transport }))).toEqual([
      { messageId: fleet.id, outcome: 'sent', code: 'sendmessage-received', transport: 'sendmessage' },
      { messageId: unknown.id, outcome: 'sent', code: 'sendmessage-received', transport: 'sendmessage' },
    ]);
  });
});
