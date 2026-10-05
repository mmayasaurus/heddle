import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FixtureAccount {
  id: string;
  configDir: string | null;
  loggedIn?: boolean;
  accountUuid?: string;
  email?: string;
  overageEnabled?: boolean;
}

export interface AccountFixtureOptions {
  used7d?: Record<string, number | null>;
  stale?: boolean;
  capturedAt?: number;
  resetsAt?: Record<string, { fiveHour?: number; sevenDay?: number }>;
  includedAccountIds?: string[];
}

/** A registry (`accounts.json`) and a fresh Claude `limits.json` in `dir`, for `heddle account pick`
 *  CLI tests; `used` is each account's 5h usage. Point HEDDLE_ACCOUNTS and HEDDLE_USAGE_DIR at it. */
export function accountFixture(
  dir: string, accounts: FixtureAccount[], used: Record<string, number>, options: AccountFixtureOptions = {},
): { accountsPath: string; usageDir: string } {
  const accountsPath = join(dir, 'accounts.json');
  writeFileSync(accountsPath, JSON.stringify({ claude: accounts }));
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{
      provider: 'claude', capturedAt: options.capturedAt ?? nowS, staleAfterSecs: 900, stale: options.stale,
      accounts: accounts.filter((account) => options.includedAccountIds?.includes(account.id) ?? true).map((account) => ({
        id: account.id,
        fiveHour: { usedPercentage: used[account.id], resetsAt: options.resetsAt?.[account.id]?.fiveHour },
        sevenDay: options.used7d?.[account.id] === null ? {} : { usedPercentage: options.used7d?.[account.id], resetsAt: options.resetsAt?.[account.id]?.sevenDay },
      })),
    }],
  }));
  return { accountsPath, usageDir: dir };
}
