import type { CommsLog, RoomRecord, RoomMember, FloorRecord } from './log.js';
import { postEnveloped, renderEnvelope, type LineageSource } from './envelope.js';
import { canSend, parseAddress, type AddressKind } from './address.js';
import type { DeliveryOutcome, MessageKind, MessageRecord, Tier } from './types.js';

/**
 * Broker — delivery discipline (HED-6). Everything between "an agent wants to say something" and
 * "the transport injects it into a target":
 *
 *   prefix addressing     `to` may be an exact address or a unique prefix of a known participant
 *                         ("codex" → codex-B); ambiguous / unknown prefixes are refused with the
 *                         candidates. `@orchestrator` is sugar for "my dispatching orchestrator".
 *   size cap              bodies over 8 KB (UTF-8 bytes) are refused before they reach the log.
 *   rate limit            per (from → to) pair: at most 5 in any 10 s window, at most 3 in any
 *                         1 s burst window; refused with retryAfterMs. Refusals do not consume.
 *   hold at gate          if the target sits at a permission gate, the message is logged but not
 *                         injected; `pump()` releases it when the gate clears (or fails it after
 *                         holdMaxMs — the recipient can still pull it from the log).
 *   serialization         one in-flight injection per target; later ones queue behind it.
 *   typed outcomes        every decision is a `deliveries` row: sent / held / released / refused /
 *                         failed / logged — never a boolean.
 *
 * The broker owns none of the transport specifics: `Transport.deliver` is whatever HED-7 (Anthropic
 * SendMessage), the MCP long-poll, or a test double provides. Target state comes from a pluggable
 * `TargetStateProvider`; the default is ledger-backed (in-flight = busy) and never reports
 * `permission-gate` until the terminal-activity tracker exists (HED-59) — that is the seam.
 */

export type TargetState = 'idle' | 'busy' | 'permission-gate' | 'exited' | 'unknown';

export interface TargetStateProvider {
  state(address: string): TargetState | Promise<TargetState>;
}

export interface Delivery {
  record: MessageRecord;
  /** The rendered text frame (text-only channels); structured channels use `record`'s fields. */
  envelope: string;
  /** Resolved recipient — for broadcasts, one Delivery per recipient. */
  target: string;
  attempt: number;
}

export interface TransportOutcome {
  ok: boolean;
  /** Short kebab-case token, e.g. "injected", "no-session", "socket-error". */
  code: string;
  reason?: string;
}

export interface Transport {
  readonly name: string;
  deliver(d: Delivery): Promise<TransportOutcome>;
}

export interface RateLimit {
  windowMs: number;
  max: number;
  burstWindowMs: number;
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { windowMs: 10_000, max: 5, burstWindowMs: 1_000, burst: 3 };
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_HOLD_MAX_MS = 10 * 60_000;
export const ORCHESTRATOR_ALIAS = '@orchestrator';

export interface BrokerOptions {
  log: CommsLog;
  ledger?: LineageSource | null;
  transport: Transport;
  targetState?: TargetStateProvider;
  rateLimit?: Partial<RateLimit>;
  maxBodyBytes?: number;
  holdMaxMs?: number;
  /** Epoch-ms clock, injectable for tests. */
  now?: () => number;
  /** Where non-fatal broker warnings go (e.g. a failing state provider). Default: process.emitWarning. */
  onWarning?: (message: string) => void;
}

export interface PostRequest {
  /** Bound by the calling process (MCP server / dispatcher / operator surface) — never model-chosen. */
  from: string;
  /** Exact address, unique prefix of a known participant, `#room`, `@all`, or `@orchestrator`. */
  to: string;
  body: string;
  kind?: MessageKind;
  requestedTier?: Tier | null;
  replyTo?: number | null;
  issue?: string | null;
  thread?: string | null;
  meta?: Record<string, unknown> | null;
  /** Rooms only: take the floor before posting (refused if another holder's lease is live). */
  holdFloor?: boolean;
  /** Rooms only: release the floor after this post (end of a multi-part reply). */
  releaseFloor?: boolean;
}

export type PostResult =
  | {
      outcome: Exclude<DeliveryOutcome, 'refused' | 'released'>;
      messageId: number;
      to: string;
      tier: Tier;
      envelope: string;
      code: string;
      reason?: string;
    }
  | {
      outcome: 'refused';
      code: RefusalCode;
      reason: string;
      to: string;
      candidates?: string[];
      retryAfterMs?: number;
    };

export type RefusalCode =
  | 'unknown-target' | 'ambiguous-target' | 'no-orchestrator' | 'body-too-large' | 'rate-limited' | 'invalid-message'
  | 'no-such-room' | 'not-a-member' | 'floor-held' | 'room-governance';

type AcceptedBase = { messageId: number; to: string; tier: Tier; envelope: string };

interface Held {
  record: MessageRecord;
  envelope: string;
  target: string;
  heldAt: number;
  attempts: number;
}

/** Default target state: the dispatch ledger knows in-flight vs finished; nothing knows "gate" yet. */
export class LedgerTargetState implements TargetStateProvider {
  constructor(private log: CommsLog, private ledger?: LineageSource | null) {}
  state(address: string): TargetState {
    const p = this.log.participant(address);
    if (!p || p.kind !== 'child' || p.dispatchId == null || !this.ledger) return 'unknown';
    const row = this.ledger.get(p.dispatchId);
    if (!row) return 'unknown';
    return row.finished_at == null ? 'busy' : 'exited';
  }
}

export class Broker {
  private readonly log: CommsLog;
  private readonly ledger: LineageSource | null;
  private readonly transport: Transport;
  private readonly targetState: TargetStateProvider;
  private readonly rate: RateLimit;
  private readonly maxBodyBytes: number;
  private readonly holdMaxMs: number;
  private readonly now: () => number;
  private readonly onWarning: (message: string) => void;
  /** Accept timestamps per "from->to" pair (only accepted posts consume budget). */
  private readonly stamps = new Map<string, number[]>();
  /** Per-target delivery chains — the "one in-flight injection per target" rule. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private held: Held[] = [];
  private pumping: Promise<{ released: number; failed: number; stillHeld: number }> | null = null;
  private sweepCounter = 0;

  constructor(opts: BrokerOptions) {
    this.log = opts.log;
    this.ledger = opts.ledger ?? null;
    this.transport = opts.transport;
    this.targetState = opts.targetState ?? new LedgerTargetState(opts.log, opts.ledger);
    this.rate = { ...DEFAULT_RATE_LIMIT, ...(opts.rateLimit ?? {}) };
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.holdMaxMs = opts.holdMaxMs ?? DEFAULT_HOLD_MAX_MS;
    this.now = opts.now ?? Date.now;
    this.onWarning = opts.onWarning ?? ((m) => process.emitWarning(m, 'HeddleBrokerWarning'));
  }

  // ------------------------------------------------------------------ addressing

  /**
   * Resolve `to`, in this order:
   *   1. `@orchestrator` → the sender's parent (children only);
   *   2. a room / `@all` / `operator` → itself;
   *   3. an exactly registered participant → itself;
   *   4. a unique prefix of registered participants → that participant ("codex" → codex-B);
   *      several matches → ambiguous (refused with the candidates);
   *   5. any other syntactically valid address (an agent that has not spoken yet, an unminted
   *      child) → itself — intent is recorded, the transport decides deliverability;
   *   6. otherwise → unknown.
   * Registered participants take precedence over the bare grammar because almost every fleet id
   * is ALSO a valid address form — "codex" must mean codex-B when that is the only codex-*.
   */
  resolveTarget(from: string, to: string): { address: string; kind: AddressKind } | Extract<PostResult, { outcome: 'refused' }> {
    if (to === ORCHESTRATOR_ALIAS) {
      const me = this.log.participant(from);
      if (!me || me.kind !== 'child' || !me.parent) {
        return { outcome: 'refused', code: 'no-orchestrator', to, reason: `${from} is not a child; @orchestrator has no meaning for it` };
      }
      return { address: me.parent, kind: 'agent' };
    }
    if (typeof to !== 'string' || to.length === 0) {
      return { outcome: 'refused', code: 'unknown-target', to: String(to ?? ''), reason: 'empty target' };
    }
    const parsed = parseAddress(to);
    if (parsed && (parsed.kind === 'room' || parsed.kind === 'broadcast' || parsed.kind === 'operator')) return { address: to, kind: parsed.kind };
    const registered = this.log.participant(to);
    if (registered) return { address: to, kind: registered.kind };
    const candidates = this.log.participantsWithPrefix(to);
    if (candidates.length === 1) return { address: candidates[0].address, kind: candidates[0].kind };
    if (candidates.length > 1) {
      const names = candidates.map((c) => c.address);
      return { outcome: 'refused', code: 'ambiguous-target', to, candidates: names, reason: `${JSON.stringify(to)} matches ${names.length} participants: ${names.join(', ')}` };
    }
    if (parsed) return { address: to, kind: parsed.kind };
    return { outcome: 'refused', code: 'unknown-target', to, reason: `${JSON.stringify(to)} is neither a valid address nor a prefix of a registered participant` };
  }

  // ------------------------------------------------------------------ rate limit

  /** Check (without consuming) the pair's budget; returns the retryAfterMs that clears BOTH limits. */
  private overLimit(pairKey: string): number | null {
    const now = this.now();
    if (++this.sweepCounter % 256 === 0) this.sweepStamps(now);
    const list = (this.stamps.get(pairKey) ?? []).filter((t) => now - t < this.rate.windowMs);
    if (list.length === 0) this.stamps.delete(pairKey); else this.stamps.set(pairKey, list);
    let wait = 0;
    if (list.length >= this.rate.max) wait = Math.max(wait, list[0] + this.rate.windowMs - now);
    const burst = list.filter((t) => now - t < this.rate.burstWindowMs);
    if (burst.length >= this.rate.burst) wait = Math.max(wait, burst[0] + this.rate.burstWindowMs - now);
    return wait > 0 ? wait : null;
  }

  /** Drop pairs whose whole window has expired, so a long-lived broker's memory stays bounded. */
  private sweepStamps(now: number): void {
    for (const [key, list] of this.stamps) {
      if (list.every((t) => now - t >= this.rate.windowMs)) this.stamps.delete(key);
    }
  }

  private consume(pairKey: string): void {
    const list = this.stamps.get(pairKey) ?? [];
    list.push(this.now());
    this.stamps.set(pairKey, list);
  }

  // ------------------------------------------------------------------ pre-flight

  /** Size cap + rate limit. Returns null when the post may proceed. */
  private checkConstraints(from: string, to: string, body: string): { code: RefusalCode; reason: string; retryAfterMs?: number } | null {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > this.maxBodyBytes) return { code: 'body-too-large', reason: `body is ${bytes} bytes; cap is ${this.maxBodyBytes}` };
    const pairKey = `${from}->${to}`;
    const retryAfterMs = this.overLimit(pairKey);
    if (retryAfterMs !== null) {
      // (No "/" inside the template: some static analysers read `${a}/${b}` as a regex literal.)
      return { code: 'rate-limited', retryAfterMs,
        reason: `${pairKey}: max ${this.rate.max} per ${this.rate.windowMs} ms, burst ${this.rate.burst} per ${this.rate.burstWindowMs} ms; retry in ${retryAfterMs} ms` };
    }
    return null;
  }

  // ------------------------------------------------------------------ rooms

  /**
   * May `from` post to `room` right now? Operator: always. Otherwise the room must exist and be
   * open or list the sender as a member; and no other holder's floor lease may be live. With
   * `holdFloor` the sender takes (or renews) the floor as part of the check.
   */
  private checkRoom(from: string, room: string, holdFloor: boolean): { code: RefusalCode; reason: string; retryAfterMs?: number } | null {
    const r = this.log.room(room);
    if (!r) return { code: 'no-such-room', reason: `${room} does not exist (rooms are created by the operator or an orchestrator)` };
    if (from !== 'operator' && !r.open && !this.log.member(room, from)) {
      return { code: 'not-a-member', reason: `${from} is not a member of ${room} (workers cannot self-join; ask your orchestrator or the operator)` };
    }
    const floor = this.log.floor(room);
    if (floor && floor.holder !== from) {
      const retryAfterMs = Math.max(0, Date.parse(floor.expiresAt) - this.now());
      return { code: 'floor-held', reason: `${floor.holder} holds the floor of ${room} (lease ends ${floor.expiresAt}); no interleaved replies`, retryAfterMs };
    }
    if (holdFloor || (floor && floor.holder === from)) {
      // Take (or renew) the floor atomically; losing the race to another holder is a floor-held refusal.
      const got = this.log.acquireFloor(room, from);
      if (!got) {
        const now = this.log.floor(room);
        return { code: 'floor-held', reason: `${now?.holder ?? 'someone'} took the floor of ${room} first`, retryAfterMs: now ? Math.max(0, Date.parse(now.expiresAt) - this.now()) : 0 };
      }
    }
    return null;
  }

  /** Who may govern rooms: the operator and fleet agents (orchestrators). Children never. */
  private governs(actor: string): boolean {
    const k = parseAddress(actor)?.kind;
    return k === 'operator' || k === 'agent';
  }

  private governanceRefusal(actor: string, room: string, reason: string): PostResult {
    return this.refuse(actor, room, 'room-governance', reason);
  }

  /** Create a room. Operator/orchestrators only; idempotent for an existing name. */
  createRoom(actor: string, name: string, opts: { topic?: string | null; open?: boolean } = {}): { room: RoomRecord } | Extract<PostResult, { outcome: 'refused' }> {
    if (!this.governs(actor)) return this.governanceRefusal(actor, name, `${actor} may not create rooms (operator/orchestrators only)`) as Extract<PostResult, { outcome: 'refused' }>;
    if (parseAddress(name)?.kind !== 'room') return this.governanceRefusal(actor, name, `${JSON.stringify(name)} is not a #room name`) as Extract<PostResult, { outcome: 'refused' }>;
    return { room: this.log.createRoom({ name, by: actor, topic: opts.topic ?? null, open: opts.open ?? false }) };
  }

  /**
   * Add a member. Operator/orchestrators only — a worker asking to join itself is refused and
   * ledgered; an orchestrator may add its own children (and peers), the operator anyone.
   */
  addMember(actor: string, room: string, address: string): { member: RoomMember } | Extract<PostResult, { outcome: 'refused' }> {
    const refused = (reason: string) => this.governanceRefusal(actor, room, reason) as Extract<PostResult, { outcome: 'refused' }>;
    if (!this.governs(actor)) return refused(`${actor} may not change room membership (workers cannot self-join)`);
    if (!this.log.room(room)) return refused(`no such room ${room}`);
    const target = parseAddress(address);
    if (!target || !canSend(target)) return refused(`${JSON.stringify(address)} cannot be a member`);
    if (target.kind === 'child' && actor !== 'operator' && target.parent !== actor) {
      return refused(`${actor} may only add its own children (${address} belongs to ${target.parent})`);
    }
    return { member: this.log.addMember({ room, address, by: actor }) };
  }

  removeMember(actor: string, room: string, address: string): { removed: boolean } | Extract<PostResult, { outcome: 'refused' }> {
    if (!this.governs(actor) && actor !== address) {
      return this.governanceRefusal(actor, room, `${actor} may not remove ${address} from ${room}`) as Extract<PostResult, { outcome: 'refused' }>;
    }
    return { removed: this.log.removeMember(room, address) };
  }

  /** Take/renew the floor of a room the actor may post to. */
  acquireFloor(actor: string, room: string, leaseMs?: number): { floor: FloorRecord } | Extract<PostResult, { outcome: 'refused' }> {
    const gate = this.checkRoom(actor, room, false);
    if (gate) return this.refuse(actor, room, gate.code, gate.reason, undefined, gate.retryAfterMs) as Extract<PostResult, { outcome: 'refused' }>;
    const floor = this.log.acquireFloor(room, actor, leaseMs);
    if (!floor) {
      const held = this.log.floor(room)!;
      return this.refuse(actor, room, 'floor-held', `${held.holder} holds the floor of ${room}`, undefined, Math.max(0, Date.parse(held.expiresAt) - this.now())) as Extract<PostResult, { outcome: 'refused' }>;
    }
    return { floor };
  }

  releaseFloor(actor: string, room: string): { released: boolean } {
    return { released: this.log.releaseFloor(room, actor) };
  }

  // ------------------------------------------------------------------ post

  async post(req: PostRequest): Promise<PostResult> {
    const from = parseAddress(req.from);
    if (!from || !canSend(from)) {
      // `from` is bound by the host process, so this is a programming error, not a sender mistake.
      throw new Error(`broker.post: invalid or non-sending from address ${JSON.stringify(req.from)}`);
    }

    const resolved = this.resolveTarget(req.from, req.to);
    if ('outcome' in resolved) return this.refuse(req.from, req.to, resolved.code, resolved.reason, resolved.candidates, resolved.retryAfterMs);
    const to = resolved.address;
    const kind = resolved.kind;
    const via = to !== req.to ? ` (requested as ${JSON.stringify(req.to)})` : '';

    const constraint = this.checkConstraints(req.from, to, req.body ?? '');
    if (constraint) return this.refuse(req.from, to, constraint.code, constraint.reason + via, undefined, constraint.retryAfterMs);
    if (kind === 'room') {
      const gate = this.checkRoom(req.from, to, req.holdFloor === true);
      if (gate) return this.refuse(req.from, to, gate.code, gate.reason, undefined, gate.retryAfterMs);
    }
    const pairKey = `${req.from}->${to}`;

    // `resolvedFrom` is broker-authored provenance: whatever the caller put there is dropped.
    const { resolvedFrom: _callerResolvedFrom, ...callerMeta } = req.meta ?? {};
    void _callerResolvedFrom;
    let enveloped;
    try {
      enveloped = postEnveloped(this.log, this.ledger, {
        from: req.from, to, body: req.body, kind: req.kind, requestedTier: req.requestedTier,
        replyTo: req.replyTo, issue: req.issue, thread: req.thread,
        meta: { ...callerMeta, ...(to !== req.to ? { resolvedFrom: req.to } : {}) },
      });
    } catch (err) {
      return this.refuse(req.from, to, 'invalid-message', (err as Error).message ?? String(err));
    }
    this.consume(pairKey);
    const { record, envelope } = enveloped;
    const base = { messageId: record.id, to, tier: record.tier, envelope };
    if (kind === 'room') {
      const out = this.deliverRoom(record, base);
      if (req.releaseFloor) this.log.releaseFloor(to, req.from);
      return out;
    }
    if (kind === 'broadcast') return this.deliverBroadcast(record, envelope, base);
    const d = await this.dispatchTo(record, envelope, to, req.from);
    return { ...base, outcome: d.outcome, code: d.code, ...(d.reason ? { reason: d.reason } : {}) };
  }

  /** Pull model: rooms are read when an agent wants to know; nothing is injected. */
  private deliverRoom(record: MessageRecord, base: AcceptedBase): PostResult {
    this.log.recordDelivery({ messageId: record.id, from: record.from, to: record.to, outcome: 'logged', code: 'room-pull', transport: this.transport.name });
    return { ...base, outcome: 'logged', code: 'room-pull' };
  }

  /**
   * @all fan-out: concurrent ACROSS recipients (per-recipient serialization still holds — each
   * dispatchTo goes through that recipient's delivery chain); the result summarises the fan-out.
   */
  private async deliverBroadcast(record: MessageRecord, envelope: string, base: AcceptedBase): Promise<PostResult> {
    const recipients = this.log.participants().map((p) => p.address).filter((a) => a !== record.from);
    if (recipients.length === 0) {
      this.log.recordDelivery({ messageId: record.id, from: record.from, to: record.to, outcome: 'logged', code: 'no-recipients', transport: this.transport.name });
      return { ...base, outcome: 'logged', code: 'no-recipients' };
    }
    // Guaranteed delivery: push where the recipient has a live channel, inbox (pull) otherwise —
    // "no live session" is not a failure for a broadcast, it is the pull path.
    const outcomes = await Promise.all(recipients.map((r) => this.dispatchTo(record, envelope, r, record.from, { broadcast: true })));
    const failed = outcomes.filter((o) => o.outcome === 'failed').length;
    const heldN = outcomes.filter((o) => o.outcome === 'held').length;
    const pushed = outcomes.filter((o) => o.outcome === 'sent').length;
    const inbox = outcomes.filter((o) => o.outcome === 'logged').length;
    const n = recipients.length;
    if (failed && heldN) return { ...base, outcome: 'failed', code: 'partial-mixed', reason: `${failed}/${n} recipients failed, ${heldN}/${n} held at a permission gate` };
    if (failed) return { ...base, outcome: 'failed', code: 'partial', reason: `${failed}/${n} recipients failed` };
    if (heldN) return { ...base, outcome: 'held', code: 'partial-hold', reason: `${heldN}/${n} recipients held at a permission gate` };
    return { ...base, outcome: 'sent', code: 'broadcast', reason: `${pushed}/${n} pushed, ${inbox}/${n} to inbox` };
  }

  /** Hold if the target is at a permission gate, else inject (serialized per target). */
  private async dispatchTo(
    record: MessageRecord, envelope: string, target: string, from: string, opts: { broadcast?: boolean } = {},
  ): Promise<{ outcome: 'sent' | 'held' | 'failed' | 'logged'; code: string; reason?: string }> {
    // Order is preserved per target: while older messages for this target are still held, a new
    // one queues behind them (released in order by pump()) instead of overtaking them.
    const queuedBehind = this.held.some((h) => h.target === target);
    const state = queuedBehind ? 'permission-gate' : await this.stateOf(target);
    if (state === 'permission-gate') {
      this.held.push({ record, envelope, target, heldAt: this.now(), attempts: 1 }); // the hold itself is attempt 1
      const code = queuedBehind ? 'queued-behind-held' : 'permission-gate';
      this.log.recordDelivery({ messageId: record.id, from, to: target, outcome: 'held', code, transport: this.transport.name });
      return { outcome: 'held', code };
    }
    const res = await this.deliverSerialized(target, { record, envelope, target, attempt: 1 });
    if (!res.ok && opts.broadcast && res.code === 'no-live-session') {
      this.log.recordDelivery({ messageId: record.id, from, to: target, outcome: 'logged', code: 'inbox', reason: res.reason ?? null, transport: this.transport.name, attempt: 1 });
      return { outcome: 'logged', code: 'inbox', reason: res.reason };
    }
    this.log.recordDelivery({ messageId: record.id, from, to: target, outcome: res.ok ? 'sent' : 'failed', code: res.code, reason: res.reason ?? null, transport: this.transport.name, attempt: 1 });
    return { outcome: res.ok ? 'sent' : 'failed', code: res.code, reason: res.reason };
  }

  /** A failing state provider is not a reason to lose a message: treat it as unknown (deliver), but say so. */
  private async stateOf(target: string): Promise<TargetState> {
    try {
      return await this.targetState.state(target);
    } catch (err) {
      this.onWarning(`target-state provider failed for ${target}: ${(err as Error).message ?? String(err)} — treating as unknown`);
      return 'unknown';
    }
  }

  /** One in-flight injection per target: chain deliveries behind whatever is running for it. */
  private deliverSerialized(target: string, d: Delivery): Promise<TransportOutcome> {
    const prev = this.chains.get(target) ?? Promise.resolve();
    const run = prev.then(() => this.safeDeliver(d), () => this.safeDeliver(d));
    this.chains.set(target, run);
    run.finally(() => { if (this.chains.get(target) === run) this.chains.delete(target); });
    return run;
  }

  private async safeDeliver(d: Delivery): Promise<TransportOutcome> {
    try {
      const out = await this.transport.deliver(d);
      const ok = out.ok === true;
      const code = /^[a-z0-9-]{1,64}$/.test(out.code ?? '') ? out.code : (ok ? 'injected' : 'transport-error');
      return { ok, code, reason: out.reason };
    } catch (err) {
      return { ok: false, code: 'transport-error', reason: (err as Error).message ?? String(err) };
    }
  }

  // ------------------------------------------------------------------ holds

  /** Messages currently held (target at a permission gate), oldest first. */
  heldMessages(): ReadonlyArray<{ messageId: number; target: string; heldAt: number; attempts: number }> {
    return this.held.map((h) => ({ messageId: h.record.id, target: h.target, heldAt: h.heldAt, attempts: h.attempts }));
  }

  /**
   * Retry held messages: release the ones whose gate cleared (in order per target), fail the ones
   * held longer than holdMaxMs. Overlapping calls share one run (a slow transport cannot make a
   * timer-driven pump inject the same message twice); independent targets are pumped
   * concurrently, same-target entries strictly in order. Entries that arrive while a pump is
   * running are untouched by it and picked up by the next one.
   */
  pump(): Promise<{ released: number; failed: number; stillHeld: number }> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pumpOnce().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  private async pumpOnce(): Promise<{ released: number; failed: number; stillHeld: number }> {
    const batch = [...this.held];               // snapshot; post() may push more meanwhile
    const byTarget = new Map<string, Held[]>();
    for (const h of batch) (byTarget.get(h.target) ?? byTarget.set(h.target, []).get(h.target)!).push(h);
    const results = await Promise.all([...byTarget.values()].map((entries) => this.pumpTarget(entries)));
    const done = new Set<Held>(results.flatMap((r) => r.done));
    const released = results.reduce((n, r) => n + r.released, 0);
    const failed = results.reduce((n, r) => n + r.failed, 0);
    this.held = this.held.filter((h) => !done.has(h)); // entries pushed during the run survive
    return { released, failed, stillHeld: this.held.length };
  }

  /** One target's held entries, in order; a still-held or failed entry blocks the ones behind it. */
  private async pumpTarget(entries: Held[]): Promise<{ done: Held[]; released: number; failed: number }> {
    const done: Held[] = [];
    let released = 0, failed = 0;
    for (const h of entries) {
      const age = this.now() - h.heldAt;
      if (age > this.holdMaxMs) {               // the contract is a MAX hold time — stale instructions are not injected late
        h.attempts += 1;
        this.recordHold(h, 'failed', 'hold-timeout', `held ${age}ms (max ${this.holdMaxMs}ms); recipient can still pull it`);
        failed += 1; done.push(h);
        continue;
      }
      if (await this.stateOf(h.target) === 'permission-gate') break; // still gated (not an attempt); order kept
      h.attempts += 1;                          // a real delivery attempt (the hold itself was attempt 1)
      const res = await this.deliverSerialized(h.target, { record: h.record, envelope: h.envelope, target: h.target, attempt: h.attempts });
      if (res.ok) {
        this.recordHold(h, 'released', 'gate-cleared', res.reason ?? null);
        released += 1; done.push(h);
        continue;
      }
      // Transient transport failure after the gate cleared: keep the entry for the next pump (until
      // holdMaxMs) — every attempt is a typed row, so a flapping transport is visible, not silent.
      this.recordHold(h, 'failed', res.code, res.reason ?? null);
      break;                                    // keep order behind the failed entry
    }
    return { done, released, failed };
  }

  private recordHold(h: Held, outcome: 'released' | 'failed', code: string, reason: string | null): void {
    this.log.recordDelivery({ messageId: h.record.id, from: h.record.from, to: h.target, outcome, code, reason, transport: this.transport.name, attempt: h.attempts });
  }

  /**
   * Rebuild the in-memory hold queue from the durable log after a restart: every message whose
   * LAST delivery event for a target is `held` is still owed a release/timeout. Call once at
   * startup (channel server does); returns how many were restored.
   */
  restoreHeld(opts: { sender?: string } = {}): number {
    let restored = 0;
    for (const ev of this.log.openHolds()) { // SQL: held rows with no later resolving event — whole log, oldest first
      const record = ev.messageId == null ? null : this.log.get(ev.messageId);
      if (!record || this.held.some((h) => h.record.id === record.id && h.target === ev.to)) continue;
      // Holds belong to the process that POSTED the message; a multi-broker deployment (one
      // heddle-comms per session, shared db) restores only its own, or two brokers would race.
      if (opts.sender && record.from !== opts.sender) continue;
      this.held.push({ record, envelope: renderEnvelope(record), target: ev.to, heldAt: Date.parse(ev.ts), attempts: 1 });
      restored += 1;
    }
    return restored;
  }

  // ------------------------------------------------------------------ internals

  private refuse(from: string, to: string, code: RefusalCode, reason: string, candidates?: string[], retryAfterMs?: number): PostResult {
    this.log.recordDelivery({ messageId: null, from, to, outcome: 'refused', code, reason, transport: this.transport.name });
    return { outcome: 'refused', code, reason, to, ...(candidates ? { candidates } : {}), ...(retryAfterMs != null ? { retryAfterMs } : {}) };
  }
}
