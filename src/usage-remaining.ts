import { readProviderCaps, type AccountCaps, type CapWindow, type ProviderCaps } from './usage.js';

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

function rowNotes(provider: ProviderCaps, account: AccountCaps | null): string[] {
  return account?.noteCodes.length ? account.noteCodes : provider.noteCodes;
}

function appendRows(
  rows: UsageRemainingRow[],
  provider: ProviderCaps,
  account: AccountCaps | null,
  nowS: number,
): void {
  const stale = provider.stale || account?.stale === true;
  const noteCodes = rowNotes(provider, account);
  const windows: Array<[string, CapWindow]> = [
    ['5h', account?.fiveHour ?? provider.fiveHour],
    ['7d', account?.sevenDay ?? provider.sevenDay],
    ...Object.entries(account?.windows ?? provider.windows),
  ];

  for (const [window, cap] of windows) {
    const unavailable = stale || cap.usedPercentage === null;
    rows.push({
      provider: provider.provider,
      account: account?.id ?? null,
      window,
      usedPercentage: unavailable ? null : cap.usedPercentage,
      resetsAt: cap.resetsAt,
      resetsInSecs: cap.resetsAt === null ? null : cap.resetsAt - nowS,
      source: unavailable ? 'unavailable' : 'vendor-meter',
      stale,
      capturedAt: provider.capturedAt,
      ageSecs: provider.capturedAt === null ? null : nowS - provider.capturedAt,
      noteCodes,
    });
  }
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

  for (const provider of Object.values(caps).sort((left, right) => providerOrder(left.provider, right.provider))) {
    if (!provider.accounts.length) {
      if (accountFilter) continue;
      appendRows(rows, provider, null, nowS);
      continue;
    }
    for (const account of provider.accounts) {
      if (accountFilter && account.id.toLocaleLowerCase() !== accountFilter) continue;
      appendRows(rows, provider, account, nowS);
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
