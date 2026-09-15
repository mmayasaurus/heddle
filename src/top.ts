import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadAccountRegistry, type Account } from './accounts.js';
import { DEFAULT_COMMS_PATH, DEFAULT_SESSION_STALE_MS, type SessionRecord } from './comms/log.js';
import { DEFAULT_LEDGER_PATH } from './ledger.js';
import { readProviderCaps, type CapWindow, type CapsByProvider } from './usage.js';
import { filterByMetersPolicy, readOptedOutAccounts } from './meters-policy.js';
import type { UsageRemainingRow } from './usage-remaining.js';

export interface TopAccount {
  id: string | null;
  provider: string;
  billingClass: Account['billingClass'] | null;
  tier: Account['tier'] | null;
  loggedIn: boolean | null;
  dispatchExcluded: boolean;
  usage: UsageRemainingRow[];
}

export interface TopAgent {
  session: SessionRecord;
  /** HED-381/382 session-capture data is optional until its on-disk reader is available here. */
  model: string | null;
  contextPercent: number | null;
  worktree: null;
}

export interface TopWorker {
  state: 'in-flight' | 'recent';
  dispatch: Record<string, unknown>;
}

export interface TopView {
  accounts: TopAccount[];
  agents: TopAgent[];
  workers: TopWorker[];
  capturedAt: string;
}

export interface AssembleTopOptions {
  usageDir?: string;
  accountsPath?: string;
  commsPath?: string;
  ledgerPath?: string;
  nowS?: number;
  metersPolicyPath?: string;
}

function safeAccounts(path: string | undefined): Account[] {
  try {
    return loadAccountRegistry(path).accounts;
  } catch {
    return [];
  }
}

function safeCaps(opts: AssembleTopOptions): CapsByProvider {
  try {
    return readProviderCaps({ usageDir: opts.usageDir, accountsPath: opts.accountsPath, nowS: opts.nowS });
  } catch {
    return {};
  }
}

function usageRow(provider: string, account: string | null, window: string, cap: CapWindow, stale: boolean, capturedAt: number | null, noteCodes: string[], nowS: number): UsageRemainingRow {
  const unavailable = stale || cap.usedPercentage === null;
  return {
    provider, account, window,
    usedPercentage: unavailable ? null : cap.usedPercentage,
    resetsAt: cap.resetsAt,
    resetsInSecs: cap.resetsAt === null ? null : cap.resetsAt - nowS,
    source: unavailable ? 'unavailable' : 'vendor-meter',
    stale,
    capturedAt,
    ageSecs: capturedAt === null ? null : nowS - capturedAt,
    noteCodes,
  };
}

/** Keep the same account/provider window semantics as readUsageRemaining, from this one caps snapshot. */
function usageRows(caps: CapsByProvider, nowS: number): UsageRemainingRow[] {
  const rows: UsageRemainingRow[] = [];
  for (const provider of Object.values(caps).sort((left, right) => left.provider.localeCompare(right.provider))) {
    if (provider.accounts.length) {
      for (const account of provider.accounts) {
        const noteCodes = account.noteCodes.length ? account.noteCodes : provider.noteCodes;
        rows.push(usageRow(provider.provider, account.id, '5h', account.fiveHour, account.stale, provider.capturedAt, noteCodes, nowS));
        rows.push(usageRow(provider.provider, account.id, '7d', account.sevenDay, account.stale, provider.capturedAt, noteCodes, nowS));
        for (const [window, cap] of Object.entries(account.windows)) {
          rows.push(usageRow(provider.provider, account.id, window, cap, account.stale, provider.capturedAt, noteCodes, nowS));
        }
      }
      for (const [window, cap] of Object.entries(provider.windows)) {
        rows.push(usageRow(provider.provider, null, window, cap, provider.stale, provider.capturedAt, provider.noteCodes, nowS));
      }
      continue;
    }
    rows.push(usageRow(provider.provider, null, '5h', provider.fiveHour, provider.stale, provider.capturedAt, provider.noteCodes, nowS));
    rows.push(usageRow(provider.provider, null, '7d', provider.sevenDay, provider.stale, provider.capturedAt, provider.noteCodes, nowS));
    for (const [window, cap] of Object.entries(provider.windows)) {
      rows.push(usageRow(provider.provider, null, window, cap, provider.stale, provider.capturedAt, provider.noteCodes, nowS));
    }
  }
  return rows;
}

function accountKeys(accounts: Account[], rows: UsageRemainingRow[], caps: CapsByProvider): Array<{ provider: string; id: string | null }> {
  const keys = new Map<string, { provider: string; id: string | null }>();
  const key = (provider: string, id: string | null): string => `${provider}\0${id ?? ''}`;
  for (const account of accounts) keys.set(key(account.provider, account.id), { provider: account.provider, id: account.id });
  for (const row of rows) {
    if (row.account !== null) keys.set(key(row.provider, row.account), { provider: row.provider, id: row.account });
    else if (!caps[row.provider]?.accounts.length && row.usedPercentage !== null) keys.set(key(row.provider, null), { provider: row.provider, id: null });
  }
  for (const [provider, providerCaps] of Object.entries(caps)) {
    for (const account of providerCaps.accounts) keys.set(key(provider, account.id), { provider, id: account.id });
  }
  return [...keys.values()].sort((left, right) => left.provider.localeCompare(right.provider) || (left.id ?? '').localeCompare(right.id ?? ''));
}

function safeAgents(path: string, nowS: number): TopAgent[] {
  if (!existsSync(path)) return [];
  let db: DatabaseSync | null = null;
  try {
    // This is CommsLog.liveSessions' query with an injected clock, opened read-only so top cannot migrate the log.
    db = new DatabaseSync(path, { readOnly: true });
    const cutoff = new Date(nowS * 1_000 - DEFAULT_SESSION_STALE_MS).toISOString();
    const sessions = db.prepare(`
      SELECT address, session_id AS sessionId, session_name AS sessionName, pid, socket,
             started_at AS startedAt, heartbeat_at AS heartbeatAt
      FROM sessions WHERE heartbeat_at >= ? ORDER BY address
    `).all(cutoff) as unknown as SessionRecord[];
    return sessions.map((session) => ({ session, model: null, contextPercent: null, worktree: null }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function safeWorkers(path: string): TopWorker[] {
  if (!existsSync(path)) return [];
  let db: DatabaseSync | null = null;
  try {
    // Ledger's normal constructor configures WAL and migrations. The dashboard must never do either.
    db = new DatabaseSync(path, { readOnly: true });
    const workers = db.prepare(`
      SELECT *, CASE WHEN finished_at IS NULL THEN 'in-flight' ELSE 'recent' END AS top_state
      FROM dispatches
      WHERE execution_mode IS NULL OR execution_mode <> 'classification'
      ORDER BY CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END, id DESC
      LIMIT 20
    `).all() as Record<string, unknown>[];
    return [
      ...workers.map(({ top_state, ...dispatch }) => ({ state: top_state as TopWorker['state'], dispatch })),
    ];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Assemble only from existing local artifacts; it never polls providers or writes sidecars. */
export function assembleTop(opts: AssembleTopOptions = {}): TopView {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1_000);
  const accounts = safeAccounts(opts.accountsPath);
  const caps = safeCaps({ ...opts, nowS });
  // HED-582: gate opted-out accounts' meters BEFORE accountKeys, so the account line still appears (from the
  // registry / caps) but its meters render `—`. `top` has no per-account request, so no bypass here.
  const usage = filterByMetersPolicy(usageRows(caps, nowS), readOptedOutAccounts(opts.metersPolicyPath));
  const byRegistryKey = new Map(accounts.map((account) => [`${account.provider}\0${account.id}`, account]));
  const keys = accountKeys(accounts, usage, caps);
  const topAccounts = keys.map(({ provider, id }) => {
    const account = id === null ? undefined : byRegistryKey.get(`${provider}\0${id}`);
    const cap = id === null ? undefined : caps[provider]?.accounts.find((candidate) => candidate.id === id);
    return {
      id,
      provider,
      billingClass: account?.billingClass ?? null,
      tier: account?.tier ?? null,
      loggedIn: account?.loggedIn ?? (cap?.dispatch?.reason === 'logged-out' ? false : null),
      dispatchExcluded: cap?.dispatch?.dispatchable === false,
      usage: usage.filter((row) => row.provider === provider && (row.account === id || (
        row.account === null && id !== null && keys.find((candidate) => candidate.provider === provider && candidate.id !== null)?.id === id
      ))),
    };
  });
  const commsPath = opts.commsPath ?? (process.env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
  const ledgerPath = opts.ledgerPath ?? process.env.HEDDLE_LEDGER_DB ?? DEFAULT_LEDGER_PATH;

  return {
    accounts: topAccounts,
    agents: safeAgents(commsPath, nowS),
    workers: safeWorkers(ledgerPath),
    capturedAt: new Date(nowS * 1_000).toISOString(),
  };
}

function age(ageSecs: number | null): string {
  if (ageSecs === null) return '—';
  const minutes = Math.max(0, Math.floor(ageSecs / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''} ago`;
}

function meter(row: UsageRemainingRow): string {
  const used = row.usedPercentage === null ? '—' : `${row.usedPercentage}%`;
  return `${row.window} ${used}  ${row.source}  ${age(row.ageSecs)}${row.stale ? '  *stale*' : ''}`;
}

/**
 * Plain text by design. ccusage's bar grammar is a useful prior-art reference for Slice 2, when
 * TTY colour and glyphs can be added without changing this assembled view.
 */
export function renderTopText(view: TopView): string {
  const accounts = view.accounts.length
    ? view.accounts.flatMap((account) => [
      `${account.id === null ? account.provider : `${account.provider}/${account.id}`}  ${account.loggedIn === false ? 'logged out' : account.loggedIn === true ? 'logged in' : 'login —'}`
        + `${account.tier ? `  ${account.tier}` : ''}${account.billingClass ? `  ${account.billingClass}` : ''}`
        + `${account.dispatchExcluded ? '  dispatch excluded' : ''}`,
      ...(account.usage.length ? account.usage.map((row) => `  ${meter(row)}`) : ['  —']),
    ])
    : ['(no data)'];
  const agents = view.agents.length
    ? view.agents.map((agent) => `${agent.session.address}  ${agent.session.sessionId ?? '—'}  ${agent.model ?? '—'}  context ${agent.contextPercent ?? '—'}`)
    : ['(no data)'];
  const workers = view.workers.length
    ? view.workers.map((worker) => {
      const dispatch = worker.dispatch;
      return `#${dispatch.id ?? '—'}  ${worker.state}  ${dispatch.task_class ?? '—'}  ${dispatch.provider ?? '—'}/${dispatch.model ?? '—'}  ${dispatch.issue ?? '—'}`;
    })
    : ['(no data)'];
  return [`HEDDLE TOP  ${view.capturedAt}`, '', 'ACCOUNTS', ...accounts, '', 'AGENTS', ...agents, '', 'WORKERS', ...workers].join('\n');
}
