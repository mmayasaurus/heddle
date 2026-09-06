import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatUsageRemaining,
  readUsageRemaining,
} from '../src/usage-remaining.js';
import { useTempResources } from './helpers.js';
import { runCli } from './helpers/cli.js';

const nowS = 1_800_000_000;
const { tempDir } = useTempResources('heddle-usage-remaining-test-');

function usageDir(fixtureNowS = nowS): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: fixtureNowS - 30,
    limits: [
      {
        provider: 'claude',
        capturedAt: fixtureNowS - 240,
        staleAfterSecs: 900,
        stale: false,
        accounts: [{
          id: 'alpha',
          fiveHour: { usedPercentage: 31, resetsAt: fixtureNowS + 6_300 },
          sevenDay: { usedPercentage: 12, resetsAt: fixtureNowS + 3 * 86_400 },
          stale: false,
          noteCodes: [],
        }],
      },
      {
        provider: 'codex',
        capturedAt: fixtureNowS - 3_600,
        staleAfterSecs: 7_200,
        stale: true,
        noteCodes: ['codex.meterUnavailable'],
        accounts: [{
          id: 'beta',
          fiveHour: { usedPercentage: null, resetsAt: fixtureNowS + 1_200 },
          sevenDay: { usedPercentage: 44, resetsAt: fixtureNowS + 2 * 86_400 },
          stale: false,
          noteCodes: [],
        }],
      },
    ],
  }));
  return dir;
}

describe('heddle usage --remaining', () => {
  it('renders a fresh vendor meter with usage, reset time, source, and age', () => {
    const rows = readUsageRemaining({ usageDir: usageDir(), nowS });
    const table = formatUsageRemaining(rows);

    expect(rows.find((row) => row.provider === 'claude' && row.account === 'alpha' && row.window === '5h'))
      .toMatchObject({ usedPercentage: 31, resetsInSecs: 6_300, source: 'vendor-meter', ageSecs: 240 });
    expect(table).toMatch(/claude\/alpha.*5h.*31%.*1h45m.*vendor-meter.*4m/);
  });

  it('marks null and stale windows unavailable without rendering a used percentage', () => {
    const rows = readUsageRemaining({ usageDir: usageDir(), nowS });
    const table = formatUsageRemaining(rows);
    const unavailable = rows.find((row) => row.provider === 'codex' && row.account === 'beta' && row.window === '5h');
    const line = table.split('\n').find((entry) => entry.includes('codex/beta') && entry.includes('  5h'))!;
    const usedColumn = line.trim().split(/\s{2,}/)[2];

    expect(unavailable).toMatchObject({
      usedPercentage: null,
      source: 'unavailable',
      stale: true,
      noteCodes: ['codex.meterUnavailable'],
    });
    expect(usedColumn).toBe('—');
    expect(usedColumn).not.toMatch(/[\d%]/);
    expect(line).toContain('codex.meterUnavailable');
  });

  it('keeps CLI JSON rows in parity with the table rows', async () => {
    const cliNowS = Math.floor(Date.now() / 1_000);
    const dir = usageDir(cliNowS);
    const expected = readUsageRemaining({ usageDir: dir, nowS: cliNowS });
    const [table, json] = await Promise.all([
      runCli(['usage', '--remaining'], { env: { HEDDLE_USAGE_DIR: dir } }),
      runCli(['usage', '--remaining', '--json'], { env: { HEDDLE_USAGE_DIR: dir } }),
    ]);
    const tableRows = table.stdout.trim().split('\n').slice(1).filter(Boolean);
    const jsonRows = JSON.parse(json.stdout) as Array<{ source: string }>;

    expect(table).toMatchObject({ code: 0, stderr: '' });
    expect(json).toMatchObject({ code: 0, stderr: '' });
    expect(jsonRows).toHaveLength(tableRows.length);
    expect(jsonRows.map((row) => row.source)).toEqual(expected.map((row) => row.source));
  });

  it('filters rows to an account id case-insensitively', () => {
    const rows = readUsageRemaining({ usageDir: usageDir(), nowS, account: 'ALPHA' });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.account === 'alpha')).toBe(true);
  });
});
