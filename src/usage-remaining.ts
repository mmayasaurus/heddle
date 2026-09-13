import { readProviderCaps, type CapWindow } from './usage.js';

export type UsageRemainingSource = 'vendor-meter' | 'unavailable';

export interface UsageRemainingRow {
  provider: string;
  account: string | null;
  window: string;
  usedPercentage: number | null;
  resetsAt: number | null;
  resetsInSecs: number | null;
  source: UsageRemainingSource;
  stale: boolean;
  capturedAt: number | null;
  ageSecs: number | null;
  noteCodes: string[];
}

export interface UsageRemainingOptions {
  usageDir?: string;
  accountsPath?: string;
  nowS?: number;
  account?: string;
}

const PROVIDER_ORDER = ['claude', 'codex', 'cursor', 'gemini'];

function providerOrder(left: string, right: string): number {
  const leftIndex = PROVIDER_ORDER.indexOf(left);
  const rightIndex = PROVIDER_ORDER.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? PROVIDER_ORDER.length : leftIndex)
      - (rightIndex === -1 ? PROVIDER_ORDER.length : rightIndex);
  }
  return left.localeCompare(right);
}

interface RowInput {
  provider: string;
  account: string | null;
  window: string;
  cap: CapWindow;
  stale: boolean;
  capturedAt: number | null;
  noteCodes: string[];
  nowS: number;
}

function pushRow(rows: UsageRemainingRow[], input: RowInput): void {
  const { cap } = input;
  // A row is unavailable when its OWN capture is stale or the window has no percentage — it then
  // shows a dash, never a number. Freshness is judged at the row's own level (per-account for an
  // account row, per-provider for a provider row), so a fresh account is never blanked by a stale
  // provider-level mirror.
  const unavailable = input.stale || cap.usedPercentage === null;
  rows.push({
    provider: input.provider,
    account: input.account,
    window: input.window,
    usedPercentage: unavailable ? null : cap.usedPercentage,
    resetsAt: cap.resetsAt,
    resetsInSecs: cap.resetsAt === null ? null : cap.resetsAt - input.nowS,
    source: unavailable ? 'unavailable' : 'vendor-meter',
    stale: input.stale,
    capturedAt: input.capturedAt,
    ageSecs: input.capturedAt === null ? null : input.nowS - input.capturedAt,
    noteCodes: input.noteCodes,
  });
}

/** Read the provider mirror and turn every account/window cap into a remaining-quota display row. */
export function readUsageRemaining(opts: UsageRemainingOptions = {}): UsageRemainingRow[] {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const caps = readProviderCaps({
    usageDir: opts.usageDir,
    accountsPath: opts.accountsPath,
    nowS,
  });
  const accountFilter = opts.account?.toLocaleLowerCase();
  const rows: UsageRemainingRow[] = [];

  const providers = Object.values(caps).sort((left, right) => providerOrder(left.provider, right.provider));
  for (const provider of providers) {
    const { capturedAt } = provider;
    if (provider.accounts.length) {
      for (const account of provider.accounts) {
        if (accountFilter && account.id.toLocaleLowerCase() !== accountFilter) continue;
        // Per-account rows use the ACCOUNT's own freshness: the Claude tap keeps per-account
        // captures current even when the assembled provider-level mirror is stale, so OR-ing in
        // provider.stale here would blank live account data (review: codeant/cursor on #124).
        const stale = account.stale;
        const noteCodes = account.noteCodes.length ? account.noteCodes : provider.noteCodes;
        pushRow(rows, { provider: provider.provider, account: account.id, window: '5h', cap: account.fiveHour, stale, capturedAt, noteCodes, nowS });
        pushRow(rows, { provider: provider.provider, account: account.id, window: '7d', cap: account.sevenDay, stale, capturedAt, noteCodes, nowS });
        for (const [id, cap] of Object.entries(account.windows)) {
          pushRow(rows, { provider: provider.provider, account: account.id, window: id, cap, stale, capturedAt, noteCodes, nowS });
        }
      }
      // Provider-level named windows are the binding view across accounts (cursor included-* /
      // usage-based, codex per-model buckets) and are NOT carried on the per-account rows — emit
      // them ONCE (account: null) so provider meters are never hidden when accounts exist. A `??`
      // over an empty {} would have kept the empty map and dropped these entirely (same review).
      if (!accountFilter) {
        for (const [id, cap] of Object.entries(provider.windows)) {
          pushRow(rows, { provider: provider.provider, account: null, window: id, cap, stale: provider.stale, capturedAt, noteCodes: provider.noteCodes, nowS });
        }
      }
      continue;
    }
    if (accountFilter) continue;
    const noteCodes = provider.noteCodes;
    pushRow(rows, { provider: provider.provider, account: null, window: '5h', cap: provider.fiveHour, stale: provider.stale, capturedAt, noteCodes, nowS });
    pushRow(rows, { provider: provider.provider, account: null, window: '7d', cap: provider.sevenDay, stale: provider.stale, capturedAt, noteCodes, nowS });
    for (const [id, cap] of Object.entries(provider.windows)) {
      pushRow(rows, { provider: provider.provider, account: null, window: id, cap, stale: provider.stale, capturedAt, noteCodes, nowS });
    }
  }
  return rows;
}

function humanizeDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d${hours ? `${hours}h` : ''}`;
  if (hours) return `${hours}h${minutes ? `${minutes}m` : ''}`;
  return `${minutes}m`;
}

function sourceText(row: UsageRemainingRow): string {
  if (row.source === 'vendor-meter') return row.source;
  return `${row.source} (${row.noteCodes[0] ?? (row.stale ? 'stale' : 'no data')})`;
}

/** Format the same rows emitted by `--json` as a readable, aligned terminal table. */
export function formatUsageRemaining(rows: UsageRemainingRow[]): string {
  const headings = ['PROVIDER/ACCOUNT', 'WINDOW', 'USED%', 'RESETS-IN', 'SOURCE', 'AGE'];
  const values = rows.map((row) => [
    row.account ? `${row.provider}/${row.account}` : row.provider,
    row.window,
    row.usedPercentage === null ? '—' : `${Number.isInteger(row.usedPercentage) ? row.usedPercentage : row.usedPercentage.toFixed(1)}%`,
    row.resetsInSecs === null ? '—' : row.resetsInSecs <= 0 ? 'resetting' : humanizeDuration(row.resetsInSecs),
    sourceText(row),
    row.ageSecs === null ? '—' : humanizeDuration(row.ageSecs),
  ]);
  const widths = headings.map((heading, index) => Math.max(
    heading.length,
    ...values.map((row) => (row.at(index) ?? '').length),
  ));
  const format = (row: string[]): string => row.map((value, index) => value.padEnd(widths.at(index) ?? 0)).join('  ');
  return [format(headings), ...values.map(format)].join('\n');
}
