import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { RouteTarget, RoutingTable } from './routing.js';
import { bindingWindow, type CapsByProvider, type ProviderCaps } from './usage.js';

/**
 * Cap-aware routing (HED-67) + Claude account advice (HED-68) — pure decisions over the caps that
 * src/usage.ts read. Ground truth that motivated it (2026-08-15): six Fable orchestrators burned a
 * full Claude 5h window in ~50 min while codex sat at 8%/2% weekly and gemini at 6% — the router
 * has to push labor to idle providers by itself.
 *
 * Rules (policy.cap_aware_routing in the routing YAML; defaults below):
 *  - route-away: if the PRIMARY provider's binding window (5h, else 7d) is >= route_away_at_pct and
 *    the class declares a fallback whose own window is under the threshold, run the fallback and say
 *    why (`route_reason`). Both over → run the primary anyway (soft cap) and say so.
 *  - Cursor pools (W's model, Maya-corrected): `included-total` gates the Cursor-Models routes
 *    (cursor-grok-*, composer-*, auto) — soft route-away; `included-api` gates NAMED third-party
 *    models (kimi-k3, …) — at >= 100% (or noteCode cursor.includedApiExhausted) they bill on-demand,
 *    so heddle REFUSES them (never on-demand $); `usage-based` limit reached
 *    (cursor.onDemandLimitReached) → refuse everything on that Cursor account.
 *  - Explicit routes (caller named provider+model) are never routed away — naming it is the
 *    choice — but the metered-pool REFUSALS still apply.
 *  - Unknown/stale caps never route away and never refuse.
 * Every decision carries a `routeReason` string that goes to the ledger, so the routing table can
 * be tuned from what actually happened.
 */

export interface CapAwarePolicy {
  enabled: boolean;
  routeAwayAtPct: number;
}
export const DEFAULT_CAP_AWARE_POLICY: CapAwarePolicy = { enabled: true, routeAwayAtPct: 90 };

export function capAwarePolicy(table: RoutingTable): CapAwarePolicy {
  const node = (table.policy as any)?.cap_aware_routing ?? {};
  const pct = Number(node.route_away_at_pct);
  return {
    enabled: node.enabled !== false,
    // 0 is valid ("always route away"); >100 is valid ("never"); negatives/NaN fall to the default.
    routeAwayAtPct: Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_CAP_AWARE_POLICY.routeAwayAtPct,
  };
}

export interface RouteDecision {
  target: RouteTarget;
  /** The class fallback that remains available AFTER this decision (undefined once consumed). */
  fallback?: RouteTarget;
  /** True when the decision moved the run onto the class's declared fallback because of a cap. */
  routedAwayForCap: boolean;
  /** Always set — what the ledger records as `route_reason`. */
  routeReason: string;
  /** Present iff the dispatch must be refused (metered pool exhausted / on-demand hard stop). */
  refusal?: { code: 'metered-pool-exhausted'; reason: string };
  /** Human-readable trace (one line per check) for `heddle route` / `plan_dispatch`. */
  checks: string[];
}

/** Cursor's own models draw from `included-total`; anything else in its catalog is a named third-party model. */
export function isCursorNativeModel(model: string): boolean {
  return /^(cursor-|composer|auto$)/.test(model);
}

/** The Cursor account heddle's dispatches bill: the cursor-agent login row when W reports it. */
function cursorAccountRow(caps: ProviderCaps): { windows: Record<string, { usedPercentage: number | null }>; noteCodes: string[]; who: string } {
  // heddle's dispatches bill the cursor-agent login — prefer its row whenever present and fresh,
  // even if activeAccount points at the (informational) IDE row.
  const row = caps.accounts.find((a) => a.id === 'cursor-agent-keychain' && !a.stale)
    ?? caps.accounts.find((a) => a.id === caps.activeAccount && !a.stale);
  if (row) return { windows: row.windows, noteCodes: row.noteCodes, who: `account ${row.id}` };
  return { windows: caps.windows, noteCodes: caps.noteCodes, who: 'binding view' };
}

/**
 * The STRUCTURAL never-on-demand checks for a target, independent of the soft route-away policy —
 * also re-applied by dispatch() before any runtime failure-fallback runs (a below-threshold primary
 * failing over to cursor must not bypass an on-demand hard stop).
 */
export function hardRefusal(target: RouteTarget, caps: CapsByProvider): string | null {
  const tcaps = caps[target.provider];
  if (target.provider === 'cursor' && tcaps) return cursorRefusal(target.model, tcaps);
  return null;
}

/** Cursor-specific hard checks; null when nothing blocks. */
function cursorRefusal(model: string, caps: ProviderCaps): string | null {
  if (caps.stale || caps.source === 'none') return null;
  const acct = cursorAccountRow(caps);
  if (acct.noteCodes.includes('cursor.onDemandLimitReached')) {
    return `cursor ${acct.who}: usage-based (on-demand) spend limit reached — every further Cursor request would fail or bill on-demand`;
  }
  if (!isCursorNativeModel(model)) {
    const api = acct.windows['included-api']?.usedPercentage ?? null;
    if (acct.noteCodes.includes('cursor.includedApiExhausted') || (api !== null && api >= 100)) {
      return `cursor ${acct.who}: included-api pool ${api === null ? 'exhausted' : `${api.toFixed(1)}%`} — named ` +
        `third-party model "${model}" would bill on-demand until the billing cycle resets (never on-demand $)`;
    }
  }
  return null;
}

/** The percentage that binds a given target: cursor → the pool its model draws from; others → 5h/7d. */
function bindingFor(target: RouteTarget, caps: ProviderCaps): { label: string; used: number } | null {
  if (caps.stale || caps.source === 'none') return null;
  if (target.provider === 'cursor') {
    const acct = cursorAccountRow(caps);
    const id = isCursorNativeModel(target.model) ? 'included-total' : 'included-api';
    const used = acct.windows[id]?.usedPercentage ?? null;
    return used === null ? null : { label: `${id} ${used.toFixed(0)}%`, used };
  }
  const bw = bindingWindow(caps);
  return bw && bw.window.usedPercentage !== null ? { label: `${bw.name} ${bw.window.usedPercentage.toFixed(0)}%`, used: bw.window.usedPercentage } : null;
}

export function decideRoute(
  table: RoutingTable, target: RouteTarget, fallback: RouteTarget | undefined, caps: CapsByProvider,
  opts: { explicit: boolean; claudeAccounts?: ClaudeAccount[] },
): RouteDecision {
  const policy = capAwarePolicy(table);
  const checks: string[] = [];
  const src = (p: string) => !caps[p] || caps[p].source === 'none' ? 'no snapshot' : `${caps[p].source}${caps[p].stale ? ', stale' : ''}`;

  // Hard refusals (never-on-demand billing) are STRUCTURAL — they apply to every route, explicit or
  // not, and are NOT disabled by policy.cap_aware_routing.enabled (that switch governs the soft
  // route-away only).
  const tcaps = caps[target.provider];
  const why = hardRefusal(target, caps);
  if (why) {
    checks.push(`REFUSE: ${why}`);
    return { target, fallback, routedAwayForCap: false, routeReason: `cap:refuse ${why}`, refusal: { code: 'metered-pool-exhausted', reason: why }, checks };
  }

  if (!policy.enabled) {
    return { target, fallback, routedAwayForCap: false, routeReason: 'cap-aware routing disabled (policy)', checks: [...checks, 'policy.cap_aware_routing.enabled = false (soft route-away off; hard billing guards stay)'] };
  }

  // Fable soft cap (HED-76): a FABLE-model class route moves to its class fallback when even the
  // best addressable account's Fable-weekly estimate is at/over the advise threshold — the weekly
  // Fable share (soft cap 50%) binds long before the raw 5h/7d windows. Soft semantics throughout:
  // explicit routes are never moved (naming fable is the choice), a missing/stale estimate is
  // UNKNOWN (no-op), a blocked or absent fallback keeps the primary with the check recorded, and
  // only the FABLE-ATTRIBUTED estimate is consulted — non-Fable work never counts against it.
  if (!opts.explicit && target.provider === 'claude' && target.model === 'fable') {
    const best = bestFableWeekly(caps.claude, opts.claudeAccounts ?? []);
    if (best === null) {
      checks.push('claude fable-weekly: no fresh estimate on any addressable account — no fable-soft-cap decision');
    } else {
      checks.push(`claude fable-weekly best ${best.pct.toFixed(0)}% (account ${best.id}) vs fable soft cap ${FABLE_SOFT_CAP_ADVISE_PCT}`);
      if (best.pct >= FABLE_SOFT_CAP_ADVISE_PCT && fallback) {
        const fbWhy = hardRefusal(fallback, caps);
        if (fbWhy) {
          checks.push(`fable soft cap hit but the fallback is blocked (${fbWhy}) — running the primary`);
        } else {
          checks.push(`FABLE SOFT CAP → ${fallback.provider}/${fallback.model}`);
          return {
            target: fallback, fallback: undefined, routedAwayForCap: true,
            routeReason: `cap:fable-soft-cap fable-weekly ${best.pct.toFixed(0)}%>=${FABLE_SOFT_CAP_ADVISE_PCT} → ${fallback.provider}/${fallback.model}`,
            checks,
          };
        }
      }
    }
  }

  if (opts.explicit) {
    const b = tcaps ? bindingFor(target, tcaps) : null;
    checks.push(`explicit route ${target.provider}/${target.model} — never routed away` + (b ? ` (${target.provider} ${b.label})` : ''));
    return { target, fallback, routedAwayForCap: false, routeReason: `explicit-route${b ? ` (${target.provider} ${b.label})` : ''}`, checks };
  }

  const primary = tcaps ? bindingFor(target, tcaps) : null;
  if (!primary) {
    checks.push(`${target.provider}: caps unknown (${src(target.provider)}) — no route-away`);
    return { target, fallback, routedAwayForCap: false, routeReason: `cap:unknown ${target.provider} (${src(target.provider)})`, checks };
  }
  checks.push(`${target.provider} ${primary.label} vs route_away_at_pct ${policy.routeAwayAtPct} (${src(target.provider)})`);
  if (primary.used < policy.routeAwayAtPct) {
    return { target, fallback, routedAwayForCap: false, routeReason: `cap:ok ${target.provider} ${primary.label}`, checks };
  }
  if (!fallback) {
    checks.push('over threshold but the class declares no fallback — running the primary');
    return { target, fallback, routedAwayForCap: false, routeReason: `cap:over ${target.provider} ${primary.label} (no fallback) → ran primary`, checks };
  }
  const fcaps = caps[fallback.provider];
  const fbRefusal = fallback.provider === 'cursor' && fcaps ? cursorRefusal(fallback.model, fcaps) : null;
  const fb = fcaps ? bindingFor(fallback, fcaps) : null;
  if (fbRefusal) {
    checks.push(`fallback ${fallback.provider}/${fallback.model} blocked: ${fbRefusal} — running the primary`);
    return { target, fallback: undefined, routedAwayForCap: false, routeReason: `cap:over ${target.provider} ${primary.label}, fallback refused (${fbRefusal}) → ran primary`, checks };
  }
  if (fb && fb.used >= policy.routeAwayAtPct) {
    checks.push(`fallback ${fallback.provider} ${fb.label} also over — running the primary (fallback kept for failure retry: the cap is soft)`);
    return { target, fallback, routedAwayForCap: false, routeReason: `cap:both-over ${target.provider} ${primary.label}, ${fallback.provider} ${fb.label} → ran primary`, checks };
  }
  // DELIBERATE (raised by several reviewers): an unknown fallback does NOT keep us on the primary.
  // The primary is KNOWN to be at/over the route-away threshold; "unknown" is absence of data, not
  // a bad signal — and the "unknown never refuses" rule above already guarantees the fallback can't
  // hard-refuse on stale data. Worst case it fails and the failure path retries/refuses (with the
  // hard guards re-checked). The live case that set this: claude fresh at 94% while the codex
  // mirror was stale — staying on claude would have burned the last 6% of a known-nearly-exhausted
  // pool to honor missing data. route_reason/checks say "caps unknown" so the ledger shows it.
  checks.push(`ROUTE AWAY → ${fallback.provider}/${fallback.model}` + (fb ? ` (${fallback.provider} ${fb.label})` : ` (${fallback.provider} caps unknown, ${src(fallback.provider)})`));
  return {
    target: fallback, fallback: undefined, routedAwayForCap: true,
    routeReason: `cap:route-away ${target.provider} ${primary.label}>=${policy.routeAwayAtPct} → ${fallback.provider}/${fallback.model}` + (fb ? ` (${fb.label})` : ' (caps unknown)'),
    checks,
  };
}

// ---------------------------------------------------------------------------------------------
// HED-68 — Claude accounts: registry + "which account has the most 5h headroom" (advisory today).
// ---------------------------------------------------------------------------------------------

export const DEFAULT_ACCOUNTS_PATH = join(homedir(), '.heddle', 'accounts.json');

export interface ClaudeAccount {
  id: string;
  /** null = the default login (~/.claude): do NOT set CLAUDE_CONFIG_DIR for it (auth status breaks). */
  configDir: string | null;
  email?: string;
  note?: string;
  /**
   * false = the dir's credential is gone (e.g. the default login was switched over it) — the account
   * is NOT addressable until the operator runs `claude /login` there. The picker never selects it
   * and a pin to it is refused. Absent = assumed logged in (registries predating the field).
   */
  loggedIn?: boolean;
}

/** `~/.heddle/accounts.json` → `claude[]`. Missing/corrupt → []. Never throws. */
export function readClaudeAccounts(path: string = process.env.HEDDLE_ACCOUNTS ?? DEFAULT_ACCOUNTS_PATH): ClaudeAccount[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { claude?: unknown };
    if (!Array.isArray(raw.claude)) return [];
    return (raw.claude as Record<string, unknown>[])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({
        id: a.id as string,
        configDir: typeof a.configDir === 'string' && a.configDir ? a.configDir : null,
        email: typeof a.email === 'string' ? a.email : undefined,
        note: typeof a.note === 'string' ? a.note : undefined,
        loggedIn: a.loggedIn === false ? false : undefined,
      }));
  } catch {
    return [];
  }
}

/** Which registry account THIS process runs as (CLAUDE_CONFIG_DIR → registry; unset → the default). */
export function currentClaudeAccount(accounts: ClaudeAccount[], env: NodeJS.ProcessEnv = process.env): ClaudeAccount | null {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  if (!dir) return accounts.find((a) => a.configDir === null) ?? null;
  return accounts.find((a) => a.configDir === dir || (a.configDir && basename(a.configDir) === basename(dir))) ?? null;
}

export interface AccountAdvice {
  /** The account with the most 5h headroom among those with a fresh capture; null when nothing is known. */
  best: { id: string; usedPct: number; configDir: string | null } | null;
  /** The account this process runs as, with its own 5h if known. */
  current: { id: string; usedPct: number | null } | null;
  /** Per-account view for the trace / UI. */
  known: { id: string; usedPct: number | null; stale: boolean }[];
  /** One line for an in-session refusal instruction / `heddle route`. */
  line: string;
}

export function adviseClaudeAccount(caps: ProviderCaps | undefined, accounts: ClaudeAccount[], env: NodeJS.ProcessEnv = process.env): AccountAdvice {
  // A snapshot that is stale/absent at the PROVIDER level is unusable regardless of per-row flags.
  const usable = caps !== undefined && !caps.stale && caps.source !== 'none';
  const rows = (usable ? caps.accounts : []).map((a) => ({ id: a.id, usedPct: a.stale ? null : a.fiveHour.usedPercentage, stale: a.stale }));
  const known = accounts.map((a) => rows.find((r) => r.id === a.id) ?? { id: a.id, usedPct: null, stale: true });
  const loggedOut = new Set(accounts.filter((a) => a.loggedIn === false).map((a) => a.id));
  const fresh = known.filter((r): r is { id: string; usedPct: number; stale: boolean } => r.usedPct !== null && !loggedOut.has(r.id));
  const bestRow = fresh.sort((x, y) => x.usedPct - y.usedPct)[0];
  const best = bestRow ? { id: bestRow.id, usedPct: bestRow.usedPct, configDir: accounts.find((a) => a.id === bestRow.id)?.configDir ?? null } : null;
  const cur = currentClaudeAccount(accounts, env);
  const current = cur ? { id: cur.id, usedPct: known.find((r) => r.id === cur.id)?.usedPct ?? null } : null;
  const line = best && current && best.id === current.id
    ? `Claude accounts: this session is already on the account with the most 5h headroom (${best.id}, ${best.usedPct.toFixed(0)}% used).`
    : best
    ? `Claude accounts: ${best.id} has the most 5h headroom (${best.usedPct.toFixed(0)}% used)` +
      (current ? `; this session is on ${current.id}${current.usedPct !== null ? ` (${current.usedPct.toFixed(0)}%)` : ' (no fresh capture)'}` : '') +
      (best.configDir ? ` — CLAUDE_CONFIG_DIR=${best.configDir}` : ' — the default login (leave CLAUDE_CONFIG_DIR unset)') + '.'
    : accounts.length
      ? `Claude accounts: ${accounts.length} registered, no fresh per-account capture (claude-<acctId>.json) — cannot advise.`
      : 'Claude accounts: none registered in ~/.heddle/accounts.json.';
  // Fable budget advisory (HED-76): surfaced whenever a fresh estimate exists so orchestration
  // sessions see WEEKLY Fable pressure, not just the 5h window.
  const fable = bestFableWeekly(caps, accounts);
  const fableLine = fable === null ? line
    : `${line} Fable-weekly: ${fable.id} lowest at ${fable.pct.toFixed(0)}%` +
      (fable.pct >= FABLE_SOFT_CAP_ADVISE_PCT ? ` — at/over the ${FABLE_SOFT_CAP_ADVISE_PCT}% soft-cap advise threshold; prefer Opus for delegated work or rotate accounts.` : '.');
  return { best, current, known, line: fableLine };
}

/**
 * HED-78 — pick the Claude account a headless worker runs on. The account with the most 5h headroom
 * among those with a FRESH per-account capture; `pin` overrides (must be a registry id); nothing
 * fresh → the default login (configDir null) when registered, else the first account. Never throws
 * for missing data — only for an unknown pin (a caller error).
 */
export interface AccountPick {
  account: ClaudeAccount;
  /** 5h used% behind the choice, null when unknown. */
  usedPct: number | null;
  /** Ledger-friendly reason, e.g. `account:acct2 (5h 12%)`, `account:acct1 pinned`, `account:acct1 default (no fresh caps)`. */
  reason: string;
  /** Env to apply: CLAUDE_CONFIG_DIR set for a non-default account; UNSET for the default login. */
  env: Record<string, string>;
  envUnset: string[];
}

/**
 * Fable budget (HED-76, Maya 2026-08-16: 58% of the weekly cap burned on day 1 while other
 * subscriptions idled): Fable is soft-capped at 50% of an account's WEEKLY allowance, and W's
 * estimator (HED-75) publishes `fableWeeklyEstimatePct` per Claude account row. At/over this
 * threshold the router routes a fable-model dispatch to the class fallback (fable-soft-cap) and
 * the account picker prefers Fable headroom for fable targets (fable-headroom). ONLY the
 * Fable-attributed estimate is consulted — non-Fable work never counts against it. null/stale
 * estimates are UNKNOWN → no-op, same discipline as every other cap.
 */
export const FABLE_SOFT_CAP_ADVISE_PCT = 45;

/** The freshest usable Fable-weekly estimate for an account row (null = unknown). */
function fableWeeklyOf(caps: ProviderCaps | undefined, accountId: string): number | null {
  if (!caps || caps.stale || caps.source === 'none') return null;
  const row = caps.accounts.find((r) => r.id === accountId);
  if (!row || row.stale) return null;
  return typeof row.fableWeeklyEstimatePct === 'number' && Number.isFinite(row.fableWeeklyEstimatePct)
    ? row.fableWeeklyEstimatePct : null;
}

/** Lowest known Fable-weekly estimate among ADDRESSABLE registry accounts (null = nothing known). */
export function bestFableWeekly(caps: ProviderCaps | undefined, accounts: ClaudeAccount[]): { id: string; pct: number } | null {
  let best: { id: string; pct: number } | null = null;
  for (const a of accounts) {
    if (a.loggedIn === false) continue;
    const pct = fableWeeklyOf(caps, a.id);
    if (pct !== null && (best === null || pct < best.pct)) best = { id: a.id, pct };
  }
  return best;
}

export function pickClaudeAccount(
  caps: ProviderCaps | undefined, accounts: ClaudeAccount[], opts: { pin?: string; routeAwayAtPct?: number; forFable?: boolean } = {},
): AccountPick | null {
  if (accounts.length === 0) return null;
  const envFor = (a: ClaudeAccount): { env: Record<string, string>; envUnset: string[] } => a.configDir
    ? { env: { CLAUDE_CONFIG_DIR: a.configDir }, envUnset: [] }
    : { env: {}, envUnset: ['CLAUDE_CONFIG_DIR'] };
  const usedOf = (id: string): number | null => {
    const row = caps?.accounts.find((r) => r.id === id);
    return row && !row.stale ? row.fiveHour.usedPercentage : null;
  };
  if (opts.pin) {
    const a = accounts.find((x) => x.id === opts.pin);
    if (!a) throw new Error(`account_pin "${opts.pin}" is not in ~/.heddle/accounts.json (known: ${accounts.map((x) => x.id).join(', ')})`);
    if (a.loggedIn === false) {
      throw new Error(
        `account_pin "${opts.pin}" is registered but NOT logged in (its credential was replaced) — run ` +
        `\`${a.configDir ? `CLAUDE_CONFIG_DIR=${a.configDir} ` : ''}claude /login\` there first, then update accounts.json.`,
      );
    }
    const used = usedOf(a.id);
    return { account: a, usedPct: used, reason: `account:${a.id} pinned${used !== null ? ` (5h ${used.toFixed(0)}%)` : ''}`, ...envFor(a) };
  }
  // A logged-out account is not addressable, whatever its caps say (a fresh keeper anchor for a dir
  // whose credential was replaced would otherwise make the picker choose an account that 401s).
  const addressable = accounts.filter((a) => a.loggedIn !== false);
  // For a FABLE-model target, Fable-weekly headroom outranks 5h headroom (HED-76): the weekly
  // Fable share is the binding constraint, and only accounts with a KNOWN estimate compete on it
  // (unknown → fall through to the normal 5h ordering — unknown never decides).
  if (opts.forFable) {
    const fable = addressable
      .map((a) => ({ a, pct: fableWeeklyOf(caps, a.id), used: usedOf(a.id) }))
      .filter((x): x is { a: ClaudeAccount; pct: number; used: number | null } => x.pct !== null)
      .sort((x, y) => x.pct - y.pct);
    if (fable.length) {
      const best = fable[0];
      const note = best.pct >= FABLE_SOFT_CAP_ADVISE_PCT ? ` — every known account is at/over the ${FABLE_SOFT_CAP_ADVISE_PCT}% Fable soft cap` : '';
      return {
        account: best.a, usedPct: best.used,
        reason: `account:${best.a.id} fable-headroom (fable-weekly ${best.pct.toFixed(0)}%, lowest of ${fable.length} known)${note}`,
        ...envFor(best.a),
      };
    }
  }
  const fresh = addressable
    .map((a) => ({ a, used: usedOf(a.id) }))
    .filter((x): x is { a: ClaudeAccount; used: number } => x.used !== null)
    .sort((x, y) => x.used - y.used);
  if (fresh.length) {
    const best = fresh[0];
    const threshold = opts.routeAwayAtPct ?? DEFAULT_CAP_AWARE_POLICY.routeAwayAtPct;
    const note = best.used >= threshold ? ` — every fresh account is at/over ${threshold}%` : '';
    return { account: best.a, usedPct: best.used, reason: `account:${best.a.id} (5h ${best.used.toFixed(0)}%, most headroom of ${fresh.length} fresh)${note}`, ...envFor(best.a) };
  }
  // Every registered account logged out → NO pick: inheriting the caller's own login beats
  // selecting a credential we KNOW 401s (the old `?? accounts[0]` escape hatch did exactly that).
  const dflt = addressable.find((a) => a.configDir === null) ?? addressable[0];
  if (!dflt) return null;
  return { account: dflt, usedPct: null, reason: `account:${dflt.id} default (no fresh per-account caps)`, ...envFor(dflt) };
}
