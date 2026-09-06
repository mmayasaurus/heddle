import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeAccount } from './capaware.js';

/**
 * HED-451 — live Claude OAuth-usage poller. Reads each registry account's usage DIRECTLY from the
 * OAuth endpoint (no live session, no statusline render, no dashboard), so cap-aware routing has real
 * per-account headroom the instant the fleet launches — killing the "blank-at-launch / 0%-by-absence"
 * trap (an account with no mirror/tap capture was previously indistinguishable from one at 0%).
 *
 * READ-ONLY, always: it reads a config dir's OAuth access token (credentials file OR the macOS
 * keychain) and GETs the usage endpoint. It NEVER mutates a credential, the keychain, or the registry
 * (rotation is HED-452). Every failure is a first-class UNKNOWN state — never a false 0%, never a
 * throw that aborts the poll.
 *
 * The response may wrap its fields in `data`; all usage and live-identity fields are parsed defensively,
 * including ISO, epoch-second, and epoch-millisecond reset timestamps.
 *
 * This module is a LEAF: it takes `ClaudeAccount[]` as a parameter (never imports the registry reader
 * at runtime) so `usage.ts` can own the poll→AccountCaps mapping without an import cycle.
 */

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** A stable, honest User-Agent — the endpoint is reverse-engineered; identify the client plainly. */
export const CLAUDE_USAGE_USER_AGENT = 'heddle-claude-usage/1.0';
export const CLAUDE_HTTP_TIMEOUT_MS = 5000;
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5000;

/** The headroom outcome for one account's poll. Only `ok` carries real windows; everything else is a
 *  distinct UNKNOWN that downstream MUST treat as "headroom unknown / do not block", never as 0%. */
export type ClaudeUsageSource =
  | 'ok' // usage endpoint 200 + a parseable JSON object
  | 'no-token' // no credential file and the keychain held no accessToken (this dir is not logged in)
  | 'keychain-unavailable' // the `security` read threw (non-zero exit / timeout / unparseable)
  | 'http-error' // usage endpoint returned a non-200
  | 'network-error' // fetch threw (DNS / socket / abort-timeout)
  | 'parse-error'; // 200 but the body was not the expected shape

/** The LIVE identity, from /api/oauth/usage. `accountUuid` is the ONLY trustworthy grouping key —
 *  never a config dir, never the cached `.claude.json` oauthAccount blob (those go stale on clones). */
export interface ClaudeLiveIdentity {
  accountUuid: string;
  /** `account.email` (falling back to `account.email_address`); display only. */
  email: string | null;
  organizationUuid: string | null;
}

/** One usage window. `utilization` mirrors the endpoint's vocabulary; null = unknown (never a false 0). */
export interface ClaudeUsageWindow {
  utilization: number | null;
  /** epoch SECONDS (the endpoint gives ISO/epoch — normalized here); null when unknown. */
  resetsAt: number | null;
}

/** Extra/on-demand spend, when the endpoint exposes it. */
export interface ClaudeExtraUsage {
  usedCredits: number | null;
  monthlyLimit: number | null;
  utilization: number | null;
  resetsAt: number | null;
}

/** One registry account's poll result. A partial 200 may carry headroom without a live identity. */
export interface ClaudeAccountUsage {
  id: string;
  configDir: string | null;
  /** Carried through from the registry — a `loggedIn:false` account that still resolves a live identity
   *  is exactly the HED-446 correction signal. Surfaced here, NEVER acted on (this module is read-only). */
  loggedIn?: boolean;
  /** How the token was obtained; null when none was found. */
  tokenSource: 'credentials.json' | 'keychain' | null;
  source: ClaudeUsageSource;
  /** True whenever this row must NOT drive routing as real headroom (anything but a fresh `ok`). */
  stale: boolean;
  /** ISO-8601 timestamp of when THIS poll ran (own clock), so staleness is always visible. */
  capturedAt: string;
  liveIdentity: ClaudeLiveIdentity | null;
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  extra: ClaudeExtraUsage | null;
  modelLimits: string[];
  noteCodes: string[];
  /** Short, MASKED explanation for a non-ok source or an unresolved identity. Never contains a secret. */
  error?: string;
}

/** Accounts that share ONE live identity (account.uuid). `ids.length > 1` = an account double-drawn
 *  across config dirs — the duplicate-identity failure this poller exists to catch. */
export interface ClaudeUsageIdentityGroup {
  accountUuid: string;
  email: string | null;
  ids: string[];
  rows: ClaudeAccountUsage[];
}

export interface ClaudeUsageWarning {
  code: 'duplicate-identity' | 'no-live-identity';
  message: string;
  ids: string[];
  /** Present for `duplicate-identity`. */
  accountUuid?: string;
}

export interface ClaudeUsagePollResult {
  capturedAt: string;
  /** One row per input account, in input order. */
  rows: ClaudeAccountUsage[];
  /** Grouped by VERIFIED live identity; rows without an identity are NOT here (see `unverified`). */
  groups: ClaudeUsageIdentityGroup[];
  /** Registry ids that resolved no live identity (logged out / no token / endpoint error). */
  unverified: string[];
  /** The loud, structured warnings (also written to the warn sink). Load-bearing per HED-451. */
  warnings: ClaudeUsageWarning[];
}

const UNKNOWN_WINDOW: ClaudeUsageWindow = { utilization: null, resetsAt: null };

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Endpoint reset stamps are ISO-8601 strings (observed); tolerate epoch seconds/ms too. → epoch SECONDS. */
export function toEpochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v > 1e12 ? v / 1000 : v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

/** Some responses could nest the payload under `data`; the live ones do not. Unwrap defensively. */
function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const d = (body as { data?: unknown }).data;
    if (d && typeof d === 'object') return d;
  }
  return body;
}

const shortError = (err: unknown): string => {
  const e = err as { code?: unknown; message?: unknown };
  const code = e && (typeof e.code === 'string' || typeof e.code === 'number') ? String(e.code) : '';
  const msg = e && typeof e.message === 'string' ? e.message : String(err);
  return `${code ? `${code}: ` : ''}${msg}`.slice(0, 512);
};

// ---------------------------------------------------------------------------------------------
// Token retrieval — READ-ONLY. credentials.json when present (the default-dir path on this machine),
// else the macOS keychain (the primary source for every pinned config dir). Never throws upward.
// ---------------------------------------------------------------------------------------------

export type TokenRead =
  | { ok: true; token: string; source: 'credentials.json' | 'keychain' }
  | { ok: false; reason: 'no-token' | 'keychain-unavailable'; error?: string };

/** Injection seams so tests never touch the real keychain / filesystem credentials. */
export interface TokenReaderDeps {
  /** Resolve `~` and the default `~/.claude` service against this home (default: os.homedir()). */
  homeDir?: string;
  keychainTimeoutMs?: number;
  /** Return the raw `-w` secret (a JSON blob) or throw. Default: `security find-generic-password`. */
  readKeychain?: (service: string, timeoutMs: number) => string;
  /** Return the credentials.json contents, or null when absent/unreadable. Default: node:fs. */
  readCredentialsFile?: (path: string) => string | null;
}

/**
 * The macOS keychain generic-password SERVICE that stores a config dir's Claude OAuth credential.
 * VERIFIED 4/4 on this machine (Agent U, 2026-09-06): the default `~/.claude` uses the bare service
 * `"Claude Code-credentials"`; any pinned dir uses that plus an 8-hex `sha256(absPath)` suffix, where
 * `absPath` is the absolute dir NFC-normalized with no trailing slash.
 */
export function claudeKeychainService(configDir: string | null, homeDir: string = homedir()): string {
  const normalize = (p: string): string => p.replace(/\/+$/, '').normalize('NFC');
  const abs = normalize(configDir ?? join(homeDir, '.claude'));
  const dflt = normalize(join(homeDir, '.claude'));
  if (abs === dflt) return 'Claude Code-credentials';
  return `Claude Code-credentials-${createHash('sha256').update(abs).digest('hex').slice(0, 8)}`;
}

const extractAccessToken = (blob: string): string | null => {
  try {
    const parsed = JSON.parse(blob) as { claudeAiOauth?: { accessToken?: unknown } };
    return asStr(parsed?.claudeAiOauth?.accessToken);
  } catch {
    return null; // an unparseable blob is a tokenless read, never a crash
  }
};

const defaultReadKeychain = (service: string, timeoutMs: number): string =>
  execFileSync('security', ['find-generic-password', '-w', '-s', service], { timeout: timeoutMs, encoding: 'utf8' });

const defaultReadCredentialsFile = (path: string): string | null => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * Read an account's OAuth access token, READ-ONLY. Order (VERIFIED on this machine): a present
 * `<configDir>/.credentials.json` wins; otherwise the keychain (which is where all four pinned
 * registry dirs keep their credential). ANY keychain throw → `keychain-unavailable` (a safety net,
 * not the expected path — the login keychain is unlocked here). A keychain that returns without a
 * token → `no-token` (this dir is not logged in). Never throws.
 */
export function readClaudeAccessToken(configDir: string | null, deps: TokenReaderDeps = {}): TokenRead {
  const homeDir = deps.homeDir ?? homedir();
  const timeoutMs = deps.keychainTimeoutMs ?? CLAUDE_KEYCHAIN_TIMEOUT_MS;
  const dir = configDir ?? join(homeDir, '.claude');
  const readCredentialsFile = deps.readCredentialsFile ?? defaultReadCredentialsFile;
  const credRaw = readCredentialsFile(join(dir, '.credentials.json'));
  if (credRaw !== null) {
    const tok = extractAccessToken(credRaw);
    if (tok) return { ok: true, token: tok, source: 'credentials.json' };
    // present but tokenless → fall through to the keychain rather than declaring no-token early
  }
  const service = claudeKeychainService(configDir, homeDir);
  const readKeychain = deps.readKeychain ?? defaultReadKeychain;
  let blob: string;
  try {
    blob = readKeychain(service, timeoutMs);
  } catch (err) {
    return { ok: false, reason: 'keychain-unavailable', error: shortError(err) };
  }
  const tok = extractAccessToken(blob);
  return tok
    ? { ok: true, token: tok, source: 'keychain' }
    : { ok: false, reason: 'no-token', error: 'keychain item held no claudeAiOauth.accessToken' };
}

// ---------------------------------------------------------------------------------------------
// Defensive parsers (pure, exported for direct unit testing without any I/O).
// ---------------------------------------------------------------------------------------------

const parseWindow = (w: unknown): ClaudeUsageWindow => {
  if (!w || typeof w !== 'object') return UNKNOWN_WINDOW;
  const o = w as Record<string, unknown>;
  return { utilization: asNum(o.utilization), resetsAt: toEpochSeconds(o.resets_at) };
};

const parseExtra = (e: unknown): ClaudeExtraUsage | null => {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  return {
    usedCredits: asNum(o.used_credits),
    monthlyLimit: asNum(o.monthly_limit),
    utilization: asNum(o.utilization),
    resetsAt: toEpochSeconds(o.resets_at),
  };
};

const parseModelLimits = (limits: unknown): string[] => {
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((limit) => {
    if (!limit || typeof limit !== 'object') return [];
    const scope = (limit as { scope?: unknown }).scope;
    if (!scope || typeof scope !== 'object') return [];
    const model = (scope as { model?: unknown }).model;
    if (!model || typeof model !== 'object') return [];
    const name = asStr((model as { display_name?: unknown }).display_name);
    return name ? [name] : [];
  });
};

/** Parse a /api/oauth/usage body. A JSON OBJECT is `ok` even if individual windows are missing
 *  (missing field → that window unknown, never a false 0). Anything else is `parse-error`. */
export function parseUsageResponse(body: unknown): {
  source: 'ok' | 'parse-error';
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  extra: ClaudeExtraUsage | null;
  liveIdentity: ClaudeLiveIdentity | null;
  modelLimits: string[];
} {
  const root = unwrapData(body);
  if (!root || typeof root !== 'object') {
    return { source: 'parse-error', fiveHour: UNKNOWN_WINDOW, sevenDay: UNKNOWN_WINDOW, extra: null, liveIdentity: null, modelLimits: [] };
  }
  const o = root as Record<string, unknown>;
  return {
    source: 'ok',
    fiveHour: parseWindow(o.five_hour),
    sevenDay: parseWindow(o.seven_day),
    extra: parseExtra(o.extra_usage),
    liveIdentity: parseIdentity(root),
    modelLimits: parseModelLimits(o.limits),
  };
}

/** Parse an OAuth usage payload → live identity, or null when there is no usable `account.uuid`. */
export function parseIdentity(body: unknown): ClaudeLiveIdentity | null {
  const root = unwrapData(body);
  if (!root || typeof root !== 'object') return null;
  const acct = (root as { account?: unknown }).account;
  if (!acct || typeof acct !== 'object') return null;
  const a = acct as Record<string, unknown>;
  const accountUuid = asStr(a.uuid);
  if (!accountUuid) return null; // no uuid → nothing to group or dedup on
  const org = (root as { organization?: unknown }).organization;
  const organizationUuid = org && typeof org === 'object' ? asStr((org as Record<string, unknown>).uuid) : null;
  return { accountUuid, email: asStr(a.email) ?? asStr(a.email_address), organizationUuid };
}

// ---------------------------------------------------------------------------------------------
// The poll — one READ-ONLY GET per account, bounded by AbortSignal.timeout (never-block).
// ---------------------------------------------------------------------------------------------

export interface ClaudePollDeps extends TokenReaderDeps {
  /** Injected `fetch` (default: global fetch). Tests pass a stub — the real endpoint is NEVER hit in tests. */
  fetchImpl?: typeof fetch;
  httpTimeoutMs?: number;
  userAgent?: string;
  usageUrl?: string;
  /** Own clock, for a deterministic `capturedAt` in tests. */
  now?: () => Date;
  /** Loud-warning sink (default: process.stderr). Injected so tests can assert warnings fired. */
  warn?: (message: string) => void;
  /** Full token-read override (default: readClaudeAccessToken with the token deps). */
  readToken?: (configDir: string | null) => TokenRead;
}

const authHeaders = (token: string, userAgent: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': CLAUDE_OAUTH_BETA,
  'User-Agent': userAgent,
});

async function fetchUsage(token: string, deps: ClaudePollDeps): Promise<{
  source: ClaudeUsageSource;
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  extra: ClaudeExtraUsage | null;
  liveIdentity: ClaudeLiveIdentity | null;
  modelLimits: string[];
  error?: string;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.httpTimeoutMs ?? CLAUDE_HTTP_TIMEOUT_MS;
  const url = deps.usageUrl ?? CLAUDE_USAGE_ENDPOINT;
  const unknown = { fiveHour: UNKNOWN_WINDOW, sevenDay: UNKNOWN_WINDOW, extra: null, liveIdentity: null, modelLimits: [] };
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: authHeaders(token, deps.userAgent ?? CLAUDE_USAGE_USER_AGENT), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { source: 'network-error', ...unknown, error: shortError(err) };
  }
  if (!res.ok) return { source: 'http-error', ...unknown, error: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { source: 'parse-error', ...unknown, error: shortError(err) };
  }
  return parseUsageResponse(body);
}

/** Poll one account. Never throws: every failure becomes a first-class UNKNOWN row, never a false 0%. */
export async function pollClaudeAccountUsage(account: ClaudeAccount, deps: ClaudePollDeps = {}): Promise<ClaudeAccountUsage> {
  const capturedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = { id: account.id, configDir: account.configDir, loggedIn: account.loggedIn, capturedAt };
  const readToken = deps.readToken ?? ((cd: string | null) => readClaudeAccessToken(cd, deps));
  const tokenRead = readToken(account.configDir);
  if (!tokenRead.ok) {
    return {
      ...base,
      tokenSource: null,
      source: tokenRead.reason,
      stale: true,
      liveIdentity: null,
      fiveHour: UNKNOWN_WINDOW,
      sevenDay: UNKNOWN_WINDOW,
      extra: null,
      modelLimits: [],
      noteCodes: [`claude.oauthPoll.${tokenRead.reason}`],
      error: tokenRead.error,
    };
  }
  const usage = await fetchUsage(tokenRead.token, deps);
  const noteCodes = [`claude.oauthPoll.${usage.source}`];
  if (!usage.liveIdentity) noteCodes.push('claude.identityUnverified');
  const errBits = [usage.error, usage.liveIdentity ? undefined : 'usage response: no live identity'].filter((x): x is string => Boolean(x));
  return {
    ...base,
    tokenSource: tokenRead.source,
    source: usage.source,
    stale: usage.source !== 'ok',
    liveIdentity: usage.liveIdentity,
    fiveHour: usage.fiveHour,
    sevenDay: usage.sevenDay,
    extra: usage.extra,
    modelLimits: usage.modelLimits,
    noteCodes,
    ...(errBits.length ? { error: errBits.join('; ') } : {}),
  };
}

/**
 * Poll every registry account (in parallel), group by VERIFIED live identity, and fire the two
 * load-bearing warnings — this failure class has regressed twice:
 *   (a) duplicate-identity — two config dirs resolve to the same account.uuid (an account double-drawn);
 *   (b) no-live-identity  — a config dir resolves no identity (logged out / no token / endpoint error).
 * Both go to `result.warnings` AND the warn sink (stderr by default). `loggedIn` is carried through on
 * every row but never filters or decides here (that correction is HED-446).
 */
export async function pollClaudeUsage(accounts: ClaudeAccount[], deps: ClaudePollDeps = {}): Promise<ClaudeUsagePollResult> {
  const capturedAt = (deps.now?.() ?? new Date()).toISOString();
  const warn = deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const rows = await Promise.all(accounts.map((a) => pollClaudeAccountUsage(a, deps)));

  const byUuid = new Map<string, ClaudeAccountUsage[]>();
  const unverified: string[] = [];
  for (const row of rows) {
    if (row.liveIdentity) {
      const list = byUuid.get(row.liveIdentity.accountUuid) ?? [];
      list.push(row);
      byUuid.set(row.liveIdentity.accountUuid, list);
    } else {
      unverified.push(row.id);
    }
  }
  const groups: ClaudeUsageIdentityGroup[] = [...byUuid.entries()].map(([accountUuid, rs]) => ({
    accountUuid,
    email: rs[0].liveIdentity?.email ?? null,
    ids: rs.map((r) => r.id),
    rows: rs,
  }));

  const warnings: ClaudeUsageWarning[] = [];
  for (const g of groups) {
    if (g.ids.length > 1) {
      const message =
        `[claude-usage] DUPLICATE LIVE IDENTITY: registry accounts [${g.ids.join(', ')}] all resolve to ` +
        `account.uuid=${g.accountUuid}${g.email ? ` (${g.email})` : ''} — one Claude account is being DOUBLE-DRAWN ` +
        `across config dirs; its headroom must be counted once, not once per dir.`;
      warnings.push({ code: 'duplicate-identity', ids: g.ids, accountUuid: g.accountUuid, message });
      warn(message);
    }
  }
  if (unverified.length) {
    const message =
      `[claude-usage] NO LIVE IDENTITY: registry accounts [${unverified.join(', ')}] resolved no live identity ` +
      `(logged out / no token / keychain unavailable / endpoint error) — their real headroom is unknown and cannot be grouped.`;
    warnings.push({ code: 'no-live-identity', ids: unverified, message });
    warn(message);
  }

  return { capturedAt, rows, groups, unverified, warnings };
}
