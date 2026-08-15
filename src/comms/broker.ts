import type { CommsLog } from './log.js';
import { postEnveloped, type LineageSource } from './envelope.js';
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
  | 'unknown-target' | 'ambiguous-target' | 'no-orchestrator' | 'body-too-large' | 'rate-limited' | 'invalid-message';

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
  /** Accept timestamps per "from→to" pair (only accepted posts consume budget). */
  private readonly stamps = new Map<string, number[]>();
  /** Per-target delivery chains — the "one in-flight injection per target" rule. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly held: Held[] = [];

  constructor(opts: BrokerOptions) {
    this.log = opts.log;
    this.ledger = opts.ledger ?? null;
    this.transport = opts.transport;
    this.targetState = opts.targetState ?? new LedgerTargetState(opts.log, opts.ledger);
    this.rate = { ...DEFAULT_RATE_LIMIT, ...(opts.rateLimit ?? {}) };
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.holdMaxMs = opts.holdMaxMs ?? DEFAULT_HOLD_MAX_MS;
    this.now = opts.now ?? Date.now;
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
    const candidates = this.log.participants().filter((p) => p.address.startsWith(to));
    if (candidates.length === 1) return { address: candidates[0].address, kind: candidates[0].kind };
    if (candidates.length > 1) {
      const names = candidates.map((c) => c.address);
      return { outcome: 'refused', code: 'ambiguous-target', to, candidates: names, reason: `${JSON.stringify(to)} matches ${names.length} participants: ${names.join(', ')}` };
    }
    if (parsed) return { address: to, kind: parsed.kind };
    return { outcome: 'refused', code: 'unknown-target', to, reason: `${JSON.stringify(to)} is neither a valid address nor a prefix of a registered participant` };
  }

  // ------------------------------------------------------------------ rate limit

  /** Check (without consuming) the pair's budget; returns retryAfterMs when over. */
  private overLimit(pairKey: string): number | null {
    const now = this.now();
    const list = (this.stamps.get(pairKey) ?? []).filter((t) => now - t < this.rate.windowMs);
    if (list.length === 0) this.stamps.delete(pairKey); else this.stamps.set(pairKey, list); // dormant pairs don't accumulate
    if (list.length >= this.rate.max) return list[0] + this.rate.windowMs - now;
    const burst = list.filter((t) => now - t < this.rate.burstWindowMs);
    if (burst.length >= this.rate.burst) return burst[0] + this.rate.burstWindowMs - now;
    return null;
  }

  private consume(pairKey: string): void {
    const list = this.stamps.get(pairKey) ?? [];
    list.push(this.now());
    this.stamps.set(pairKey, list);
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

    const bytes = Buffer.byteLength(req.body ?? '', 'utf8');
    if (bytes > this.maxBodyBytes) {
      return this.refuse(req.from, to, 'body-too-large', `body is ${bytes} bytes; cap is ${this.maxBodyBytes}`);
    }

    const pairKey = `${req.from}→${to}`;
    const retryAfterMs = this.overLimit(pairKey);
    if (retryAfterMs !== null) {
      return this.refuse(req.from, to, 'rate-limited',
        `${pairKey}: max ${this.rate.max}/${this.rate.windowMs}ms, burst ${this.rate.burst}/${this.rate.burstWindowMs}ms; retry in ${retryAfterMs}ms`,
        undefined, retryAfterMs);
    }

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
      // Pull model: rooms are read when an agent wants to know; nothing is injected.
      this.log.recordDelivery({ messageId: record.id, from: req.from, to, outcome: 'logged', code: 'room-pull', transport: this.transport.name });
      return { ...base, outcome: 'logged', code: 'room-pull' };
    }
    if (kind === 'broadcast') {
      const recipients = this.log.participants().map((p) => p.address).filter((a) => a !== req.from);
      if (recipients.length === 0) {
        this.log.recordDelivery({ messageId: record.id, from: req.from, to, outcome: 'logged', code: 'no-recipients', transport: this.transport.name });
        return { ...base, outcome: 'logged', code: 'no-recipients' };
      }
      // Fan-out runs concurrently ACROSS recipients; per-recipient serialization still holds because
      // each dispatchTo goes through that recipient's delivery chain.
      const outcomes = await Promise.all(recipients.map((r) => this.dispatchTo(record, envelope, r, req.from)));
      const failed = outcomes.filter((o) => o.outcome === 'failed').length;
      const heldN = outcomes.filter((o) => o.outcome === 'held').length;
      const n = recipients.length;
      if (failed && heldN) return { ...base, outcome: 'failed', code: 'partial-mixed', reason: `${failed}/${n} recipients failed, ${heldN}/${n} held at a permission gate` };
      if (failed) return { ...base, outcome: 'failed', code: 'partial', reason: `${failed}/${n} recipients failed` };
      if (heldN) return { ...base, outcome: 'held', code: 'partial-hold', reason: `${heldN}/${n} recipients held at a permission gate` };
      return { ...base, outcome: 'sent', code: 'broadcast' };
    }
    const d = await this.dispatchTo(record, envelope, to, req.from);
    return { ...base, outcome: d.outcome, code: d.code, ...(d.reason ? { reason: d.reason } : {}) };
  }

  /** Hold if the target is at a permission gate, else inject (serialized per target). */
  private async dispatchTo(
    record: MessageRecord, envelope: string, target: string, from: string,
  ): Promise<{ outcome: 'sent' | 'held' | 'failed'; code: string; reason?: string }> {
    // Order is preserved per target: while older messages for this target are still held, a new
    // one queues behind them (released in order by pump()) instead of overtaking them.
    const queuedBehind = this.held.some((h) => h.target === target);
    const state = queuedBehind ? 'permission-gate' : await this.targetState.state(target);
    if (state === 'permission-gate') {
      this.held.push({ record, envelope, target, heldAt: this.now(), attempts: 0 });
      const code = queuedBehind ? 'queued-behind-held' : 'permission-gate';
      this.log.recordDelivery({ messageId: record.id, from, to: target, outcome: 'held', code, transport: this.transport.name });
      return { outcome: 'held', code };
    }
    const res = await this.deliverSerialized(target, { record, envelope, target, attempt: 1 });
    this.log.recordDelivery({ messageId: record.id, from, to: target, outcome: res.ok ? 'sent' : 'failed', code: res.code, reason: res.reason ?? null, transport: this.transport.name, attempt: 1 });
    return { outcome: res.ok ? 'sent' : 'failed', code: res.code, reason: res.reason };
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
   * Retry held messages: release the ones whose gate cleared, fail the ones held longer than
   * holdMaxMs. Call from a timer (or after a state change). Returns what happened.
   */
  async pump(): Promise<{ released: number; failed: number; stillHeld: number }> {
    let released = 0, failed = 0;
    const remaining: Held[] = [];
    const blocked = new Set<string>(); // a target whose older entry stays held keeps its later ones held too (order)
    for (const h of this.held) {
      h.attempts += 1;
      const expired = this.now() - h.heldAt > this.holdMaxMs;
      const state = blocked.has(h.target) ? 'permission-gate' : await this.targetState.state(h.target);
      if (state === 'permission-gate') {
        if (expired) {
          this.log.recordDelivery({ messageId: h.record.id, from: h.record.from, to: h.target, outcome: 'failed', code: 'hold-timeout',
            reason: `held ${this.now() - h.heldAt}ms at a permission gate; recipient can still pull it`, transport: this.transport.name, attempt: h.attempts });
          failed += 1;
        } else {
          remaining.push(h);
          blocked.add(h.target);
        }
        continue;
      }
      const res = await this.deliverSerialized(h.target, { record: h.record, envelope: h.envelope, target: h.target, attempt: h.attempts });
      if (res.ok) {
        this.log.recordDelivery({ messageId: h.record.id, from: h.record.from, to: h.target, outcome: 'released', code: 'gate-cleared',
          reason: res.reason ?? null, transport: this.transport.name, attempt: h.attempts });
        released += 1;
        continue;
      }
      // Transient transport failure after the gate cleared: keep retrying on later pumps until
      // holdMaxMs — every attempt is a typed row, so a flapping transport is visible, not silent.
      this.log.recordDelivery({ messageId: h.record.id, from: h.record.from, to: h.target, outcome: 'failed', code: expired ? 'hold-timeout' : res.code,
        reason: expired ? `gave up after ${this.now() - h.heldAt}ms; last transport error: ${res.reason ?? res.code}` : (res.reason ?? null),
        transport: this.transport.name, attempt: h.attempts });
      if (expired) { failed += 1; } else { remaining.push(h); blocked.add(h.target); }
    }
    this.held.splice(0, this.held.length, ...remaining);
    return { released, failed, stillHeld: remaining.length };
  }

  // ------------------------------------------------------------------ internals

  private refuse(from: string, to: string, code: RefusalCode, reason: string, candidates?: string[], retryAfterMs?: number): PostResult {
    this.log.recordDelivery({ messageId: null, from, to, outcome: 'refused', code, reason, transport: this.transport.name });
    return { outcome: 'refused', code, reason, to, ...(candidates ? { candidates } : {}), ...(retryAfterMs != null ? { retryAfterMs } : {}) };
  }
}
