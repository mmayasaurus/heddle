import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeAccountUsage } from './claude-usage.js';

/**
 * Provider cap reader — what the router (HED-67) and account picker (HED-68) consult at dispatch.
 *
 * Sources, in order (all written by the dashboard/tap — heddle-core never queries a vendor):
 *   1. `~/.heddle/usage/limits.json` — the dashboard mirrors its `heddle_provider_limits` result
 *      (`{writtenAt, limits: ProviderLimit[]}`, camelCase, contract in heddle-dashboard
 *      docs/USAGE_TAP.md; pinned by its limits.golden.json fixture) on every poll while it runs.
 *      One documented shape for claude/codex/cursor/gemini incl. per-account rows, named windows
 *      (cursor `included-total` / `included-api` / `usage-based`, codex per-model buckets), `stale`,
 *      `noteCodes`, `activeAccount`.
 *   2. Raw Claude statusline tap `~/.heddle/usage/claude.json` (+ per-account
 *      `claude-<acctId>.json`) — written on every statusline render, app or no app. Used when
 *      limits.json is missing/old, because Claude is the cap the router most needs to route AWAY
 *      from. Shape: `{model, rate_limits:{five_hour:{used_percentage,resets_at}, seven_day:{…}}, capturedAt}`.
 *
 * Rules (agreed with Agent W, 2026-08-15): a snapshot older than its freshness window is UNKNOWN —
 * never route away, never refuse, on stale data; a window whose `resetsAt` is in the past has rolled
 * over → treat used as 0 until the next capture. Unknown is always the safe, no-op answer.
 */

export const DEFAULT_USAGE_DIR = join(homedir(), '.heddle', 'usage');

/** limits.json older than this (dashboard closed / crashed) → the whole mirror is unknown. */
export const LIMITS_JSON_MAX_AGE_S = 900;
/** Raw Claude tap files older than this → unknown (tap writes on every statusline render). */
export const CLAUDE_TAP_MAX_AGE_S = 600;
/** Fresh billing/login failures are trusted for this long; stale failures fail open for recovery. */
export const DISPATCH_SIGNAL_MAX_AGE_S = 6 * 60 * 60;

export type DispatchSignalReason = 'ok' | 'billing' | 'logged-out' | 'rate-capped' | 'error';

/** HED-178's per-account headless-ping result. Invalid or absent files are deliberately ignored. */
export interface DispatchSignal {
  account: string;
  dispatchable: boolean;
  reason: DispatchSignalReason;
  /** Epoch seconds when the producer's ping returned. */
  checkedAt: number;
}

export interface CapWindow {
  /** 0–100, null when the provider does not expose it or the snapshot is unusable. */
  usedPercentage: number | null;
  /** epoch seconds; null when unknown. */
  resetsAt: number | null;
}

export interface AccountCaps {
  id: string;
  label?: string;
  fiveHour: CapWindow;
  sevenDay: CapWindow;
  windows: Record<string, CapWindow>;
  noteCodes: string[];
  limitReached: boolean;
  stale: boolean;
  /** Claude only (W's HED-75 estimator): estimated share of the WEEKLY cap consumed by FABLE, in
   *  percentage points (soft cap 50). null/absent until >=3 attributed samples / other providers —
   *  optional so fixtures and the raw tap (which has no attribution) need not carry it. */
  fableWeeklyEstimatePct?: number | null;
  /** Attributed samples behind the estimate (its confidence); null/absent when no estimate. */
  fableWeeklySamples?: number | null;
  /** Optional HED-178 signal; absent is equivalent to today's no-op behavior. */
  dispatch?: DispatchSignal;
}

export interface ProviderCaps {
  provider: string;
  /** Where the numbers came from; `none` = nothing usable (treat every window as unknown).
   *  `claude-oauth` (HED-451) = live per-account OAuth-usage polls injected into readProviderCaps — like
   *  `claude-tap`, it names NO authoritative active account (activeAccount stays null). */
  source: 'limits.json' | 'claude-tap' | 'claude-oauth' | 'none';
  /** True when the snapshot must not drive routing (missing, too old, or flagged stale upstream). */
  stale: boolean;
  capturedAt: number | null;
  fiveHour: CapWindow;
  sevenDay: CapWindow;
  /** Named windows keyed by id (cursor: included-total / included-api / usage-based; codex: per-model). */
  windows: Record<string, CapWindow>;
  noteCodes: string[];
  accounts: AccountCaps[];
  /** The `accounts[].id` the top-level numbers describe (null = binding/max view or unknown). */
  activeAccount: string | null;
}

export type CapsByProvider = Record<string, ProviderCaps>;

const UNKNOWN: CapWindow = { usedPercentage: null, resetsAt: null };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A window whose reset time has passed rolled over — the provider will report ~0 on next capture. */
function normalizeWindow(w: unknown, nowS: number): CapWindow {
  if (!w || typeof w !== 'object') return UNKNOWN;
  const o = w as { usedPercentage?: unknown; resetsAt?: unknown };
  const resetsAt = num(o.resetsAt);
  const used = num(o.usedPercentage);
  if (used === null) return { usedPercentage: null, resetsAt };
  if (resetsAt !== null && resetsAt < nowS) return { usedPercentage: 0, resetsAt };
  return { usedPercentage: used, resetsAt };
}

function windowsById(list: unknown, nowS: number): Record<string, CapWindow> {
  const out: Record<string, CapWindow> = {};
  if (!Array.isArray(list)) return out;
  for (const w of list) {
    if (w && typeof w === 'object' && typeof (w as { id?: unknown }).id === 'string') {
      out[(w as { id: string }).id] = normalizeWindow(w, nowS);
    }
  }
  return out;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function unknownCaps(provider: string): ProviderCaps {
  return {
    provider, source: 'none', stale: true, capturedAt: null, fiveHour: UNKNOWN, sevenDay: UNKNOWN,
    windows: {}, noteCodes: [], accounts: [], activeAccount: null,
  };
}

function readJson(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // unreadable/corrupt = unknown, never a crash at dispatch time
  }
}

/** Read only schema-contract-v1 dispatch signals. Any bad/missing input is a no-op by design. */
export function readDispatchSignals(usageDir: string): Map<string, DispatchSignal> {
  const out = new Map<string, DispatchSignal>();
  let files: string[] = [];
  try { files = existsSync(usageDir) ? readdirSync(usageDir) : []; } catch { return out; }
  for (const file of files) {
    const match = /^claude-([A-Za-z0-9_.-]+)\.dispatch\.json$/.exec(file);
    if (!match) continue;
    const raw = readJson(join(usageDir, file)) as Record<string, unknown> | null;
    if (!raw || raw.schemaVersion !== 1 || raw.account !== match[1] || typeof raw.dispatchable !== 'boolean') continue;
    const reason = raw.reason;
    if (reason !== 'ok' && reason !== 'billing' && reason !== 'logged-out' && reason !== 'rate-capped' && reason !== 'error') continue;
    const checkedAt = num(raw.checkedAt);
    if (checkedAt === null || raw.dispatchable !== (reason === 'ok')) continue;
    out.set(raw.account, { account: raw.account, dispatchable: raw.dispatchable, reason, checkedAt });
  }
  return out;
}

/** Parse the dashboard's limits.json mirror. Returns null when absent, corrupt, or too old. */
export function readLimitsMirror(usageDir: string, nowS: number): CapsByProvider | null {
  const raw = readJson(join(usageDir, 'limits.json')) as { writtenAt?: unknown; limits?: unknown } | null;
  if (!raw || !Array.isArray(raw.limits)) return null;
  const writtenAt = num(raw.writtenAt);
  if (writtenAt === null || nowS - writtenAt > LIMITS_JSON_MAX_AGE_S) return null;
  const out: CapsByProvider = {};
  for (const L of raw.limits as Record<string, unknown>[]) {
    if (!L || typeof L.provider !== 'string') continue;
    const accounts: AccountCaps[] = Array.isArray(L.accounts)
      ? (L.accounts as Record<string, unknown>[]).filter((a) => a && typeof a === 'object').map((a) => ({
          id: typeof a.id === 'string' ? a.id : (typeof a.label === 'string' ? a.label : 'unknown'),
          label: typeof a.label === 'string' ? a.label : undefined,
          fiveHour: normalizeWindow(a.fiveHour, nowS),
          sevenDay: normalizeWindow(a.sevenDay, nowS),
          windows: windowsById(a.windows, nowS),
          noteCodes: strList(a.noteCodes),
          limitReached: a.limitReached === true,
          stale: a.stale === true,
          fableWeeklyEstimatePct: num(a.fableWeeklyEstimatePct),
          fableWeeklySamples: num(a.fableWeeklySamples),
        }))
      : [];
    // Per-provider freshness: the contract carries capturedAt + staleAfterSecs per provider — a
    // provider row can be past ITS OWN freshness window while the mirror file as a whole is fresh.
    const capturedAt = num(L.capturedAt);
    const staleAfter = num(L.staleAfterSecs);
    const pastOwnWindow = capturedAt !== null && staleAfter !== null && nowS - capturedAt > staleAfter;
    out[L.provider] = {
      provider: L.provider,
      source: 'limits.json',
      stale: L.stale === true || pastOwnWindow,
      capturedAt,
      fiveHour: normalizeWindow(L.fiveHour, nowS),
      sevenDay: normalizeWindow(L.sevenDay, nowS),
      windows: windowsById(L.windows, nowS),
      noteCodes: strList(L.noteCodes),
      accounts,
      activeAccount: typeof L.activeAccount === 'string' ? L.activeAccount : null,
    };
  }
  return out;
}

/** One raw statusline-tap file → a Claude window pair (null = missing/unusable/too old). */
function readClaudeTapFile(path: string, nowS: number): { fiveHour: CapWindow; sevenDay: CapWindow; capturedAt: number } | null {
  const raw = readJson(path) as { rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown }>; capturedAt?: unknown } | null;
  if (!raw || !raw.rate_limits) return null;
  const capturedAt = num(raw.capturedAt);
  if (capturedAt === null || nowS - capturedAt > CLAUDE_TAP_MAX_AGE_S) return null;
  const conv = (w?: { used_percentage?: unknown; resets_at?: unknown }): CapWindow =>
    normalizeWindow(w ? { usedPercentage: w.used_percentage, resetsAt: w.resets_at } : undefined, nowS);
  return { fiveHour: conv(raw.rate_limits.five_hour), sevenDay: conv(raw.rate_limits.seven_day), capturedAt };
}

/**
 * The window-keeper's anchor `claude-<acctId>.keeper.json` = {account, startedAt, resets_at, used:null,
 * source:"keeper-ping"} — written when the keeper STARTS a 5h window with a headless ping (which never
 * renders the statusline, so the tap cannot see it). Treated as a fresh capture with used ≈ 0 for that
 * window while `resets_at` is in the future; without it, accounts that only ever get keeper pings
 * (acct3/acct4) would stay "unknown" forever and never be picked (Agent R, 2026-08-15).
 */
function readKeeperAnchor(path: string, nowS: number): { fiveHour: CapWindow; capturedAt: number } | null {
  const raw = readJson(path) as { startedAt?: unknown; resets_at?: unknown; source?: unknown } | null;
  if (!raw) return null;
  const startedAt = num(raw.startedAt);
  const resetsAt = num(raw.resets_at);
  if (startedAt === null || resetsAt === null) return null;
  if (resetsAt <= nowS) return null; // the window the keeper started has already rolled over
  return { fiveHour: { usedPercentage: 0, resetsAt }, capturedAt: startedAt };
}

/** Raw Claude tap fallback: claude.json (last-seen session) + claude-<acctId>.json per account (+ keeper anchors). */
export function readClaudeTap(usageDir: string, nowS: number): ProviderCaps | null {
  const main = readClaudeTapFile(join(usageDir, 'claude.json'), nowS);
  const accounts: AccountCaps[] = [];
  let files: string[] = [];
  try { files = existsSync(usageDir) ? readdirSync(usageDir) : []; } catch { files = []; }
  const ids = new Set<string>();
  for (const f of files) {
    // Skip HED-178 dispatch signals + keeper oauth-usage sidecars: same usage dir, but NOT taps
    // (readDispatchSignals owns .dispatch.json). This reserves the `.dispatch` / `.oauth-usage`
    // filename suffixes — a registry account id must not end in them (ids are acctN; the producer
    // would write claude-<id>.dispatch.json, which for such an id would collide).
    if (/\.(dispatch|oauth-usage)\.json$/.test(f)) continue;
    const m = /^claude-([A-Za-z0-9_.-]+?)(\.keeper)?\.json$/.exec(f);
    if (m) ids.add(m[1]);
  }
  for (const id of [...ids].sort()) {
    const tap = readClaudeTapFile(join(usageDir, `claude-${id}.json`), nowS);
    const keeper = readKeeperAnchor(join(usageDir, `claude-${id}.keeper.json`), nowS);
    // freshest wins (the same rule the keeper itself uses)
    const useKeeper = keeper !== null && (tap === null || keeper.capturedAt > tap.capturedAt);
    const src = useKeeper ? keeper : tap;
    accounts.push({
      id, fiveHour: src?.fiveHour ?? UNKNOWN, sevenDay: (useKeeper ? UNKNOWN : tap?.sevenDay) ?? UNKNOWN,
      windows: {}, noteCodes: src ? (useKeeper ? ['claude.keeperAnchor'] : []) : ['claude.noCapture'],
      limitReached: false, stale: src === null,
    });
  }
  if (!main && accounts.length === 0) return null;
  return {
    provider: 'claude', source: 'claude-tap', stale: main === null, capturedAt: main?.capturedAt ?? null,
    fiveHour: main?.fiveHour ?? UNKNOWN, sevenDay: main?.sevenDay ?? UNKNOWN,
    windows: {}, noteCodes: [], accounts, activeAccount: null,
  };
}

/**
 * HED-451 — map one live OAuth-usage poll row → an AccountCaps row. A fresh 200 (`source: 'ok'`)
 * carries real windows; EVERY other outcome is stale/unknown, NEVER a false 0% (guardrail #3). The
 * poll's `utilization` maps to `usedPercentage`; normalizeWindow applies the shared rollover-to-0 rule.
 */
function claudePollToAccountCaps(row: ClaudeAccountUsage, nowS: number): AccountCaps {
  const ok = row.source === 'ok';
  return {
    id: row.id,
    fiveHour: ok ? normalizeWindow({ usedPercentage: row.fiveHour.utilization, resetsAt: row.fiveHour.resetsAt }, nowS) : UNKNOWN,
    sevenDay: ok ? normalizeWindow({ usedPercentage: row.sevenDay.utilization, resetsAt: row.sevenDay.resetsAt }, nowS) : UNKNOWN,
    windows: {},
    noteCodes: row.noteCodes,
    limitReached: false,
    stale: !ok,
  };
}

/**
 * Provider-level Claude view built purely from live polls — the source that kills the blank-at-launch
 * trap when NEITHER the dashboard mirror nor the statusline tap has written anything yet. Null when
 * there are no poll rows; stale (so it never drives routing) when NONE of the rows is a fresh `ok`.
 * capturedAt is `nowS` so a fresh poll is inside every downstream freshness budget (account-pick.ts).
 */
function readClaudePollCaps(rows: ClaudeAccountUsage[], nowS: number): ProviderCaps | null {
  if (rows.length === 0) return null;
  const accounts = rows.map((r) => claudePollToAccountCaps(r, nowS));
  return {
    provider: 'claude', source: 'claude-oauth', stale: !accounts.some((a) => !a.stale),
    capturedAt: nowS, fiveHour: UNKNOWN, sevenDay: UNKNOWN, windows: {}, noteCodes: [],
    accounts, activeAccount: null,
  };
}

/**
 * Merge incoming Claude account rows into existing by id — the SAME discipline the tap merge uses: a
 * FRESH incoming row fills a stale/absent one, and an unknown (stale) incoming row NEVER overwrites a
 * known-fresh row (which would drop a mirror row's fableWeeklyEstimatePct and a false 0% both).
 */
function mergeClaudeAccountRows(existing: AccountCaps[], incoming: AccountCaps[]): AccountCaps[] {
  const byId = new Map(existing.map((a) => [a.id, a]));
  for (const t of incoming) {
    const e = byId.get(t.id);
    if (!e || (e.stale && !t.stale)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * Everything the router needs, for every provider it might route to. Never throws; a provider with
 * no usable snapshot comes back `source: 'none', stale: true` (= unknown).
 *
 * `claudePolls` (HED-451) are live OAuth-usage poll rows a CALLER has already fetched (readProviderCaps
 * itself never queries a vendor — that would add network latency to every dispatch); merged per-account
 * by id with the tap discipline, and establishing the claude provider when mirror+tap are absent/stale.
 */
export function readProviderCaps(opts: { usageDir?: string; nowS?: number; claudePolls?: ClaudeAccountUsage[] } = {}): CapsByProvider {
  const usageDir = opts.usageDir ?? process.env.HEDDLE_USAGE_DIR ?? DEFAULT_USAGE_DIR;
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const out: CapsByProvider = {};
  const mirror = readLimitsMirror(usageDir, nowS);
  if (mirror) Object.assign(out, mirror);
  // Claude: the raw tap is fresher/independent of the app — prefer it when the mirror is missing or
  // stale for claude, and always merge per-account rows the tap knows about.
  const tap = readClaudeTap(usageDir, nowS);
  if (tap) {
    const m = out.claude;
    if (!m || m.stale) {
      out.claude = { ...tap, accounts: tap.accounts.length ? tap.accounts : (m?.accounts ?? []) };
    } else if (tap.accounts.length) {
      // Merge per-account rows by id: a FRESH tap row beats a stale/absent mirror row (the tap
      // updates on every statusline render; the mirror only while the app polls), and tap-only
      // accounts are appended — otherwise the registry account with the most headroom can vanish
      // from the advice whenever the mirror has any account list at all.
      const byId = new Map(m.accounts.map((a) => [a.id, a]));
      for (const t of tap.accounts) {
        const existing = byId.get(t.id);
        if (!existing || (existing.stale && !t.stale)) byId.set(t.id, t);
      }
      out.claude = { ...m, accounts: [...byId.values()] };
    }
  }
  // HED-451: fold in live OAuth-usage polls the caller fetched. Same merge as the tap: a fresh poll
  // row fills a stale/absent per-account row; an unknown poll row never overwrites a known-fresh row.
  // When neither mirror nor tap is usable, the poll ESTABLISHES the claude provider (the launch-trap fix).
  const polls = opts.claudePolls;
  if (polls && polls.length) {
    const pollCaps = readClaudePollCaps(polls, nowS);
    if (pollCaps) {
      const m = out.claude;
      if (m && !m.stale) {
        // A fresh mirror/tap is already the provider view — only fill/append per-account rows, never
        // downgrade it (mergeClaudeAccountRows keeps the fresh mirror row, so its fable fields survive).
        if (pollCaps.accounts.length) out.claude = { ...m, accounts: mergeClaudeAccountRows(m.accounts, pollCaps.accounts) };
      } else if (!pollCaps.stale) {
        // No usable mirror/tap AND the poll has at least one fresh row → establish the provider from the
        // poll (the launch-trap fix), carrying over any rows the earlier sources already knew.
        out.claude = { ...pollCaps, accounts: mergeClaudeAccountRows(m?.accounts ?? [], pollCaps.accounts) };
      }
      // else: nothing usable anywhere (poll all-unknown too) → leave out.claude, so it stays source:'none'.
    }
  }
  for (const p of ['claude', 'codex', 'cursor', 'gemini']) if (!out[p]) out[p] = unknownCaps(p);
  // HED-178 is independent of cap freshness: decorate the final merged Claude rows after choosing
  // mirror/tap data. Signal-only accounts get a stale unknown row so a fresh failure can exclude a
  // registry account even when no cap producer has ever emitted a row for it.
  {
    const signals = readDispatchSignals(usageDir);
    const byId = new Map(out.claude.accounts.map((a) => [a.id, a]));
    for (const [id, dispatch] of signals) {
      if (!byId.has(id)) byId.set(id, {
        id, fiveHour: UNKNOWN, sevenDay: UNKNOWN, windows: {}, noteCodes: ['claude.dispatchSignalOnly'],
        limitReached: false, stale: true, dispatch,
      });
    }
    out.claude = { ...out.claude, accounts: [...byId.values()].map((a) => {
      const dispatch = signals.get(a.id);
      return dispatch ? { ...a, dispatch } : a;
    }) };
  }
  return out;
}

/** The window that binds a provider for "should we route away": 5h when it exists, else 7d. */
export function bindingWindow(caps: ProviderCaps): { name: '5h' | '7d'; window: CapWindow } | null {
  if (caps.stale || caps.source === 'none') return null;
  if (caps.fiveHour.usedPercentage !== null) return { name: '5h', window: caps.fiveHour };
  if (caps.sevenDay.usedPercentage !== null) return { name: '7d', window: caps.sevenDay };
  return null;
}
