import { existsSync } from 'node:fs';
import { loadAccountRegistry, type Account } from './accounts.js';
import { DEFAULT_COMMS_PATH, CommsLog, type SessionRecord } from './comms/log.js';
import { DEFAULT_LEDGER_PATH, Ledger } from './ledger.js';
import { readProviderCaps, type AccountCaps } from './usage.js';
import { readUsageRemaining, type UsageRemainingRow } from './usage-remaining.js';

export interface TopAccount {
  id: string;
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
}

function safeAccounts(path: string | undefined): Account[] {
  try {
    return loadAccountRegistry(path).accounts;
  } catch {
    return [];
  }
}

function safeUsage(opts: AssembleTopOptions): UsageRemainingRow[] {
  try {
    return readUsageRemaining({ usageDir: opts.usageDir, accountsPath: opts.accountsPath, nowS: opts.nowS });
  } catch {
    return [];
  }
}

function safeCaps(opts: AssembleTopOptions): Record<string, { accounts: AccountCaps[] }> {
  try {
    return readProviderCaps({ usageDir: opts.usageDir, accountsPath: opts.accountsPath, nowS: opts.nowS });
  } catch {
    return {};
  }
}

function accountKeys(accounts: Account[], rows: UsageRemainingRow[], caps: Record<string, { accounts: AccountCaps[] }>): Array<{ provider: string; id: string }> {
  const keys = new Map<string, { provider: string; id: string }>();
  for (const account of accounts) keys.set(`${account.provider}\0${account.id}`, { provider: account.provider, id: account.id });
  for (const row of rows) {
    if (row.account !== null) keys.set(`${row.provider}\0${row.account}`, { provider: row.provider, id: row.account });
  }
  for (const [provider, providerCaps] of Object.entries(caps)) {
    for (const account of providerCaps.accounts) keys.set(`${provider}\0${account.id}`, { provider, id: account.id });
  }
  return [...keys.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
}

function safeAgents(path: string): TopAgent[] {
  if (!existsSync(path)) return [];
  let log: CommsLog | null = null;
  try {
    log = new CommsLog(path);
    return log.liveSessions().map((session) => ({ session, model: null, contextPercent: null, worktree: null }));
  } catch {
    return [];
  } finally {
    log?.close();
  }
}

function safeWorkers(path: string): TopWorker[] {
  if (!existsSync(path)) return [];
  let ledger: Ledger | null = null;
  try {
    ledger = new Ledger(path);
    const inFlight = ledger.inFlight();
    const inFlightIds = new Set(inFlight.map((row) => Number(row.id)));
    return [
      ...inFlight.map((dispatch) => ({ state: 'in-flight' as const, dispatch })),
      ...ledger.recent().filter((dispatch) => !inFlightIds.has(Number(dispatch.id))).map((dispatch) => ({ state: 'recent' as const, dispatch })),
    ];
  } catch {
    return [];
  } finally {
    ledger?.close();
  }
}

/** Assemble only from existing local artifacts; it never polls providers or writes sidecars. */
export function assembleTop(opts: AssembleTopOptions = {}): TopView {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1_000);
  const accounts = safeAccounts(opts.accountsPath);
  const usage = safeUsage({ ...opts, nowS });
  const caps = safeCaps({ ...opts, nowS });
  const byRegistryKey = new Map(accounts.map((account) => [`${account.provider}\0${account.id}`, account]));
  const topAccounts = accountKeys(accounts, usage, caps).map(({ provider, id }) => {
    const account = byRegistryKey.get(`${provider}\0${id}`);
    const cap = caps[provider]?.accounts.find((candidate) => candidate.id === id);
    return {
      id,
      provider,
      billingClass: account?.billingClass ?? null,
      tier: account?.tier ?? null,
      loggedIn: account?.loggedIn ?? (cap?.dispatch?.reason === 'logged-out' ? false : null),
      dispatchExcluded: cap?.dispatch?.dispatchable === false,
      usage: usage.filter((row) => row.provider === provider && row.account === id),
    };
  });
  const commsPath = opts.commsPath ?? (process.env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH;

  return {
    accounts: topAccounts,
    agents: safeAgents(commsPath),
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
      `${account.provider}/${account.id}  ${account.loggedIn === false ? 'logged out' : account.loggedIn === true ? 'logged in' : 'login —'}`
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
