import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ClaudeAccountUsage,
  type ClaudePollDeps,
  type TokenRead,
  claudeKeychainService,
  parseIdentity,
  parseUsageResponse,
  pollClaudeAccountUsage,
  pollClaudeUsage,
  readClaudeAccessToken,
  toEpochSeconds,
} from '../src/claude-usage.js';
import { readProviderCaps } from '../src/usage.js';
import type { ClaudeAccount } from '../src/capaware.js';
import { useTempResources } from './helpers.js';

const CAP_AT = '2026-09-06T00:00:00.000Z';
const now = () => new Date(CAP_AT);
const acct = (id: string, extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({ id, configDir: `/x/${id}`, loggedIn: true, ...extra });

/** A fetch stub that routes by URL and by the per-account bearer token — the REAL endpoint is never hit. */
function stubFetch(opts: {
  usageUrl: string;
  profileUrl: string;
  usageByToken?: Record<string, { status?: number; json?: unknown; text?: string }>;
  profileByToken?: Record<string, { status?: number; json?: unknown; text?: string }>;
  throwFor?: (url: string, token: string) => boolean;
}): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    const token = auth.replace('Bearer ', '');
    if (opts.throwFor?.(url, token)) throw new Error('network down');
    const table = url === opts.usageUrl ? opts.usageByToken : url === opts.profileUrl ? opts.profileByToken : undefined;
    const r = table?.[token];
    if (!r) throw new Error(`unexpected request ${url} token=${token}`);
    const body = r.text !== undefined ? r.text : JSON.stringify(r.json ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const URLS = { usageUrl: 'https://t.invalid/usage', profileUrl: 'https://t.invalid/profile' };

/** Deps that make a poll fully hermetic: injected token read, fetch, silent warn sink, fixed clock. */
function deps(over: Partial<ClaudePollDeps>): ClaudePollDeps {
  return { now, warn: () => {}, ...URLS, ...over };
}

describe('claudeKeychainService', () => {
  const home = '/Users/mayatobi';
  it('uses the bare service for the default dir and an 8-hex sha256 suffix for pinned dirs', () => {
    expect(claudeKeychainService(null, home)).toBe('Claude Code-credentials');
    expect(claudeKeychainService('/Users/mayatobi/.claude', home)).toBe('Claude Code-credentials');
    // Verified 4/4 on this machine (Agent U, 2026-09-06).
    expect(claudeKeychainService('/Users/mayatobi/.claude-acct1', home)).toBe('Claude Code-credentials-a92ea116');
    expect(claudeKeychainService('/Users/mayatobi/.claude-acct4', home)).toBe('Claude Code-credentials-b8ac112a');
  });
  it('normalizes trailing slashes so a dir and its slashed form share one service', () => {
    expect(claudeKeychainService('/Users/mayatobi/.claude-acct2/', home)).toBe(claudeKeychainService('/Users/mayatobi/.claude-acct2', home));
    expect(claudeKeychainService('/Users/mayatobi/.claude/', home)).toBe('Claude Code-credentials');
  });
});

describe('toEpochSeconds', () => {
  it('parses ISO strings, epoch seconds, and epoch millis; rejects garbage', () => {
    expect(toEpochSeconds('2026-09-06T03:49:59.987311+00:00')).toBe(Math.floor(Date.parse('2026-09-06T03:49:59.987311+00:00') / 1000));
    expect(toEpochSeconds(1_786_846_200)).toBe(1_786_846_200); // seconds pass through
    expect(toEpochSeconds(1_786_846_200_000)).toBe(1_786_846_200); // millis → seconds
    expect(toEpochSeconds('not a date')).toBeNull();
    expect(toEpochSeconds(null)).toBeNull();
    expect(toEpochSeconds({})).toBeNull();
  });
});

describe('parseUsageResponse', () => {
  it('parses the live top-level shape (ISO resets_at, extra_usage) as ok', () => {
    const out = parseUsageResponse({
      five_hour: { utilization: 14, resets_at: '2026-09-06T03:49:59.987311+00:00' },
      seven_day: { utilization: 3, resets_at: '2026-09-06T14:59:59.987399+00:00' },
      extra_usage: { used_credits: 0, monthly_limit: 15000, utilization: 0 },
      limits: [{ scope: { model: { display_name: 'Claude Fable' } } }, { scope: null }],
    });
    expect(out.source).toBe('ok');
    expect(out.fiveHour.utilization).toBe(14);
    expect(out.fiveHour.resetsAt).toBe(Math.floor(Date.parse('2026-09-06T03:49:59.987311+00:00') / 1000));
    expect(out.sevenDay.utilization).toBe(3);
    expect(out.extra).toMatchObject({ usedCredits: 0, monthlyLimit: 15000, utilization: 0 });
    expect(out.modelLimits).toEqual(['Claude Fable']);
  });
  it('tolerates a legacy data wrapper', () => {
    expect(parseUsageResponse({ data: { five_hour: { utilization: 40 } } })).toMatchObject({ source: 'ok', fiveHour: { utilization: 40 } });
  });
  it('missing/malformed windows are unknown but a JSON object is still ok (never a false 0)', () => {
    const out = parseUsageResponse({ seven_day: 'nope' });
    expect(out.source).toBe('ok');
    expect(out.fiveHour).toEqual({ utilization: null, resetsAt: null });
    expect(out.sevenDay).toEqual({ utilization: null, resetsAt: null });
    expect(out.extra).toBeNull();
  });
  it('a non-object body is parse-error', () => {
    expect(parseUsageResponse('garbage').source).toBe('parse-error');
    expect(parseUsageResponse(null).source).toBe('parse-error');
  });
});

describe('parseIdentity', () => {
  it('reads account.uuid + account.email + organization.uuid', () => {
    expect(parseIdentity({ account: { uuid: 'U1', email: 'a@x' }, organization: { uuid: 'O1' } })).toEqual({
      accountUuid: 'U1', email: 'a@x', organizationUuid: 'O1',
    });
  });
  it('falls back to email_address, and needs a uuid to be an identity at all', () => {
    expect(parseIdentity({ account: { uuid: 'U2', email_address: 'b@x' } })).toMatchObject({ accountUuid: 'U2', email: 'b@x' });
    expect(parseIdentity({ account: { email: 'nouuid@x' } })).toBeNull();
    expect(parseIdentity({})).toBeNull();
    expect(parseIdentity('x')).toBeNull();
  });
});

describe('readClaudeAccessToken (read-only, injected I/O)', () => {
  const tokenBlob = (t: string) => JSON.stringify({ claudeAiOauth: { accessToken: t } });
  it('prefers a present credentials.json', () => {
    const out = readClaudeAccessToken('/x/acct1', { readCredentialsFile: () => tokenBlob('CRED'), readKeychain: () => { throw new Error('should not reach keychain'); } });
    expect(out).toEqual({ ok: true, token: 'CRED', source: 'credentials.json' });
  });
  it('falls back to the keychain when there is no credentials.json', () => {
    const out = readClaudeAccessToken('/x/acct1', { readCredentialsFile: () => null, readKeychain: () => tokenBlob('KC') });
    expect(out).toEqual({ ok: true, token: 'KC', source: 'keychain' });
  });
  it('a credentials.json without a token still falls through to the keychain', () => {
    const out = readClaudeAccessToken('/x/acct1', { readCredentialsFile: () => JSON.stringify({ claudeAiOauth: {} }), readKeychain: () => tokenBlob('KC2') });
    expect(out).toEqual({ ok: true, token: 'KC2', source: 'keychain' });
  });
  it('ANY keychain throw is keychain-unavailable, never a crash', () => {
    const out = readClaudeAccessToken('/x/acct1', { readCredentialsFile: () => null, readKeychain: () => { const e = new Error('timed out'); (e as { code?: string }).code = 'ETIMEDOUT'; throw e; } });
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ reason: 'keychain-unavailable' });
    if (!out.ok) expect(out.error).toContain('ETIMEDOUT');
  });
  it('a keychain item without a token is no-token', () => {
    const out = readClaudeAccessToken('/x/acct1', { readCredentialsFile: () => null, readKeychain: () => JSON.stringify({ nope: true }) });
    expect(out).toMatchObject({ ok: false, reason: 'no-token' });
  });
});

describe('pollClaudeAccountUsage (hermetic)', () => {
  const okToken: TokenRead = { ok: true, token: 'tok', source: 'keychain' };
  it('resolves live identity from the usage response without requesting another endpoint', async () => {
    const requested: string[] = [];
    const row = await pollClaudeAccountUsage(acct('acct4'), deps({
      readToken: () => okToken,
      fetchImpl: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response(JSON.stringify({
          data: {
            five_hour: { utilization: 15 },
            seven_day: { utilization: 3 },
            account: { uuid: 'U4', email_address: 'v@x' },
            organization: { uuid: 'O4' },
          },
        }));
      }) as typeof fetch,
    }));
    expect(requested).toEqual([URLS.usageUrl]);
    expect(row.liveIdentity).toEqual({ accountUuid: 'U4', email: 'v@x', organizationUuid: 'O4' });
  });
  it('happy path: 200 usage + 200 profile → ok, fresh windows, live identity', async () => {
    const row = await pollClaudeAccountUsage(acct('acct4'), deps({
      readToken: () => okToken,
      fetchImpl: stubFetch({
        ...URLS,
        usageByToken: { tok: { json: { five_hour: { utilization: 15 }, seven_day: { utilization: 3 }, account: { uuid: 'U4', email_address: 'v@x' }, organization: { uuid: 'O4' } } } },
        profileByToken: { tok: { json: { account: { uuid: 'U4', email: 'v@x' }, organization: { uuid: 'O4' } } } },
      }),
    }));
    expect(row).toMatchObject({ id: 'acct4', source: 'ok', stale: false, tokenSource: 'keychain', capturedAt: CAP_AT });
    expect(row.fiveHour.utilization).toBe(15);
    expect(row.liveIdentity).toEqual({ accountUuid: 'U4', email: 'v@x', organizationUuid: 'O4' });
    expect(row.loggedIn).toBe(true);
  });

  it('non-200 usage → http-error, stale, windows unknown (NOT 0%)', async () => {
    const row = await pollClaudeAccountUsage(acct('acct1'), deps({
      readToken: () => okToken,
      fetchImpl: stubFetch({ ...URLS, usageByToken: { tok: { status: 429 } }, profileByToken: { tok: { json: { account: { uuid: 'U1' } } } } }),
    }));
    expect(row).toMatchObject({ source: 'http-error', stale: true });
    expect(row.fiveHour.utilization).toBeNull();
    expect(row.error).toContain('HTTP 429');
    expect(row.liveIdentity).toBeNull();
  });

  it('malformed usage JSON → parse-error, stale, unknown', async () => {
    const row = await pollClaudeAccountUsage(acct('acct1'), deps({
      readToken: () => okToken,
      fetchImpl: stubFetch({ ...URLS, usageByToken: { tok: { text: 'not json{' } }, profileByToken: { tok: { json: { account: { uuid: 'U1' } } } } }),
    }));
    expect(row).toMatchObject({ source: 'parse-error', stale: true });
    expect(row.fiveHour.utilization).toBeNull();
  });

  it('fetch throwing → network-error, stale, unknown', async () => {
    const row = await pollClaudeAccountUsage(acct('acct1'), deps({
      readToken: () => okToken,
      fetchImpl: stubFetch({ ...URLS, throwFor: (url) => url === URLS.usageUrl, profileByToken: { tok: { json: { account: { uuid: 'U1' } } } } }),
    }));
    expect(row).toMatchObject({ source: 'network-error', stale: true });
    expect(row.fiveHour.utilization).toBeNull();
  });

  it('usage 200 without account.uuid → fresh partial headroom, NO identity, identityUnverified note', async () => {
    const row = await pollClaudeAccountUsage(acct('acct2'), deps({
      readToken: () => okToken,
      fetchImpl: stubFetch({ ...URLS, usageByToken: { tok: { json: { five_hour: { utilization: 35 } } } }, profileByToken: { tok: { status: 401 } } }),
    }));
    expect(row).toMatchObject({ source: 'ok', stale: false }); // headroom is real and usable
    expect(row.fiveHour.utilization).toBe(35);
    expect(row.liveIdentity).toBeNull();
    expect(row.noteCodes).toContain('claude.identityUnverified');
    expect(row.error).toContain('no live identity');
  });

  it('token absent → no-token, stale, unknown, no network calls', async () => {
    const row = await pollClaudeAccountUsage(acct('acct3'), deps({
      readToken: () => ({ ok: false, reason: 'no-token' }),
      fetchImpl: (() => { throw new Error('must not fetch without a token'); }) as unknown as typeof fetch,
    }));
    expect(row).toMatchObject({ source: 'no-token', stale: true, tokenSource: null, liveIdentity: null });
  });
});

describe('pollClaudeUsage — grouping & loud warnings', () => {
  const profileJson = (uuid: string, email: string) => ({ account: { uuid, email } });
  const usageJson = (u5: number, uuid?: string, email?: string) => ({
    five_hour: { utilization: u5 }, seven_day: { utilization: 1 },
    ...(uuid ? { account: { uuid, email_address: email } } : {}),
  });

  it('fires duplicate-identity when two config dirs resolve to the SAME account.uuid', async () => {
    const warns: string[] = [];
    const readToken = (cd: string | null): TokenRead => ({ ok: true, token: `tok:${cd}`, source: 'keychain' });
    const fetchImpl = stubFetch({
      ...URLS,
      usageByToken: { 'tok:/x/acct1': { json: usageJson(63, 'U-DUP', 'shared@x') }, 'tok:/x/acct3': { json: usageJson(86, 'U-DUP', 'shared@x') } },
      profileByToken: { 'tok:/x/acct1': { json: profileJson('U-DUP', 'shared@x') }, 'tok:/x/acct3': { json: profileJson('U-DUP', 'shared@x') } },
    });
    const res = await pollClaudeUsage([acct('acct1'), acct('acct3')], { now, warn: (m) => warns.push(m), readToken, fetchImpl, ...URLS });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ accountUuid: 'U-DUP', ids: ['acct1', 'acct3'] });
    const dup = res.warnings.find((w) => w.code === 'duplicate-identity');
    expect(dup).toMatchObject({ ids: ['acct1', 'acct3'], accountUuid: 'U-DUP' });
    expect(warns.some((w) => w.includes('DUPLICATE LIVE IDENTITY') && w.includes('acct1') && w.includes('acct3'))).toBe(true);
    expect(res.unverified).toEqual([]);
  });

  it('fires no-live-identity for an account that resolves no identity, and keeps distinct ones un-warned', async () => {
    const warns: string[] = [];
    const readToken = (cd: string | null): TokenRead => (cd === '/x/acct3' ? { ok: false, reason: 'keychain-unavailable', error: 'ETIMEDOUT' } : { ok: true, token: `tok:${cd}`, source: 'keychain' });
    const fetchImpl = stubFetch({
      ...URLS,
      usageByToken: { 'tok:/x/acct1': { json: usageJson(10, 'U1', 'a@x') }, 'tok:/x/acct4': { json: usageJson(20, 'U4', 'd@x') } },
      profileByToken: { 'tok:/x/acct1': { json: profileJson('U1', 'a@x') }, 'tok:/x/acct4': { json: profileJson('U4', 'd@x') } },
    });
    const res = await pollClaudeUsage([acct('acct1'), acct('acct3'), acct('acct4')], { now, warn: (m) => warns.push(m), readToken, fetchImpl, ...URLS });
    expect(res.groups.map((g) => g.accountUuid).sort()).toEqual(['U1', 'U4']);
    expect(res.unverified).toEqual(['acct3']);
    expect(res.warnings.find((w) => w.code === 'no-live-identity')).toMatchObject({ ids: ['acct3'] });
    expect(res.warnings.find((w) => w.code === 'duplicate-identity')).toBeUndefined();
    expect(warns.some((w) => w.includes('NO LIVE IDENTITY') && w.includes('acct3'))).toBe(true);
    const acct3Row = res.rows.find((r) => r.id === 'acct3');
    expect(acct3Row).toMatchObject({ source: 'keychain-unavailable', stale: true, loggedIn: true });
  });

  it('four distinct identities → no warnings', async () => {
    const readToken = (cd: string | null): TokenRead => ({ ok: true, token: `tok:${cd}`, source: 'keychain' });
    const fetchImpl = stubFetch({
      ...URLS,
      usageByToken: Object.fromEntries(['acct1', 'acct2', 'acct3', 'acct4'].map((id) => [`tok:/x/${id}`, { json: usageJson(5, `U-${id}`, `${id}@x`) }])),
      profileByToken: Object.fromEntries(['acct1', 'acct2', 'acct3', 'acct4'].map((id) => [`tok:/x/${id}`, { json: profileJson(`U-${id}`, `${id}@x`) }])),
    });
    const res = await pollClaudeUsage(['acct1', 'acct2', 'acct3', 'acct4'].map((id) => acct(id)), { now, warn: () => {}, readToken, fetchImpl, ...URLS });
    expect(res.warnings).toEqual([]);
    expect(res.groups).toHaveLength(4);
    expect(res.unverified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// readProviderCaps injection (src/usage.ts) — the tap merge discipline applied to live polls.
// ---------------------------------------------------------------------------------------------

const okRow = (id: string, u5: number | null, u7: number | null, reset?: { r5?: number; r7?: number }): ClaudeAccountUsage => ({
  id, configDir: `/x/${id}`, loggedIn: true, tokenSource: 'keychain', source: 'ok', stale: false, capturedAt: CAP_AT,
  liveIdentity: { accountUuid: `U-${id}`, email: `${id}@x`, organizationUuid: null },
  fiveHour: { utilization: u5, resetsAt: reset?.r5 ?? null }, sevenDay: { utilization: u7, resetsAt: reset?.r7 ?? null },
  extra: null, modelLimits: [], noteCodes: ['claude.oauthPoll.ok'],
});
const unknownRow = (id: string, source: ClaudeAccountUsage['source']): ClaudeAccountUsage => ({
  id, configDir: `/x/${id}`, loggedIn: true, tokenSource: source === 'no-token' ? null : 'keychain', source, stale: true, capturedAt: CAP_AT,
  liveIdentity: null, fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null },
  extra: null, modelLimits: [], noteCodes: [`claude.oauthPoll.${source}`],
});

describe('readProviderCaps — claude-oauth poll merge', () => {
  const { tempDir } = useTempResources('heddle-claude-usage-');
  const nowS = 1_800_000_000;

  it('establishes the claude provider from a fresh poll when neither mirror nor tap exists (launch trap)', () => {
    const caps = readProviderCaps({ usageDir: tempDir(), nowS, claudePolls: [okRow('acct2', 12, 4), okRow('acct3', 40, 9)] });
    expect(caps.claude).toMatchObject({ source: 'claude-oauth', stale: false, activeAccount: null });
    const by = Object.fromEntries(caps.claude.accounts.map((a) => [a.id, a]));
    expect(by.acct2).toMatchObject({ stale: false, fiveHour: { usedPercentage: 12 }, sevenDay: { usedPercentage: 4 } });
    expect(by.acct3.fiveHour.usedPercentage).toBe(40);
    // other providers are still unknown
    expect(caps.codex).toMatchObject({ source: 'none', stale: true });
  });

  it('a rolled-over window in a fresh poll normalizes to 0%, never carries a stale utilization', () => {
    const caps = readProviderCaps({ usageDir: tempDir(), nowS, claudePolls: [okRow('acct2', 80, 50, { r5: nowS - 10 })] });
    expect(caps.claude.accounts[0].fiveHour).toEqual({ usedPercentage: 0, resetsAt: nowS - 10 });
  });

  it('keeps a fresh mirror row (with its fable estimate) and only appends poll-only accounts', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS - 10,
      limits: [{ provider: 'claude', capturedAt: nowS - 10, staleAfterSecs: 600, fiveHour: { usedPercentage: 32, resetsAt: nowS + 3600 },
        accounts: [{ id: 'acct2', fiveHour: { usedPercentage: 20, resetsAt: nowS + 3600 }, fableWeeklyEstimatePct: 30 }] }],
    }));
    const caps = readProviderCaps({ usageDir: dir, nowS, claudePolls: [okRow('acct2', 99, 5), okRow('acct3', 7, 2)] });
    expect(caps.claude.source).toBe('limits.json');
    const by = Object.fromEntries(caps.claude.accounts.map((a) => [a.id, a]));
    // fresh mirror row wins over the poll (tap discipline) — fable estimate survives, poll's 99 ignored
    expect(by.acct2).toMatchObject({ fiveHour: { usedPercentage: 20 }, fableWeeklyEstimatePct: 30 });
    // poll-only account is appended
    expect(by.acct3.fiveHour.usedPercentage).toBe(7);
  });

  it('an unknown poll row never overwrites a fresh tap row (no false 0%)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 15, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    writeFileSync(join(dir, 'claude-acct2.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 60, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    const caps = readProviderCaps({ usageDir: dir, nowS, claudePolls: [unknownRow('acct2', 'http-error')] });
    expect(caps.claude.source).toBe('claude-tap');
    expect(caps.claude.accounts.find((a) => a.id === 'acct2')).toMatchObject({ stale: false, fiveHour: { usedPercentage: 60 } });
  });

  it('an all-unknown poll leaves the provider as source:none (never fabricates freshness)', () => {
    const caps = readProviderCaps({ usageDir: tempDir(), nowS, claudePolls: [unknownRow('acct2', 'http-error'), unknownRow('acct3', 'no-token')] });
    expect(caps.claude).toMatchObject({ source: 'none', stale: true });
  });

  it('is a no-op when no polls are supplied (existing callers unaffected)', () => {
    expect(readProviderCaps({ usageDir: tempDir(), nowS }).claude).toMatchObject({ source: 'none', stale: true });
  });
});
