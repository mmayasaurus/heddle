import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingWindow, readClaudeTap, readLimitsMirror, readProviderCaps } from '../src/usage.js';
import { useTempResources } from './helpers.js';

const fixture = join(process.cwd(), 'test/fixtures/limits.golden.json');
const writtenAt = 1786831200;

describe('usage cap readers', () => {
  const { tempDir } = useTempResources('heddle-usage-test-');

  it('reads the fresh dashboard limits mirror with provider windows and account rows intact', () => {
    const dir = tempDir(); copyFileSync(fixture, join(dir, 'limits.json'));
    const caps = readLimitsMirror(dir, writtenAt + 10)!;
    expect(caps.claude).toMatchObject({ source: 'limits.json', stale: false });
    expect(caps.claude.fiveHour.usedPercentage).toBe(32);
    expect(caps.codex.fiveHour.usedPercentage).toBeNull(); expect(caps.codex.sevenDay.usedPercentage).toBe(5);
    expect(caps.codex.accounts).toHaveLength(2);
    expect(caps.cursor.windows['included-api'].usedPercentage).toBeCloseTo(86.688);
    expect(caps.cursor.accounts[0]).toMatchObject({ id: 'cursor-ide', noteCodes: expect.arrayContaining(['cursor.includedApiExhausted']), overageEnabled: true, overageSpend: 0 });
    expect(caps.gemini.fiveHour.usedPercentage).toBeCloseTo(3.93);
  });

  it('applies the declared Claude overage posture from a temp account registry and leaves absent declarations unknown', () => {
    const dir = tempDir(); const nowS = writtenAt + 10;
    const accountsPath = join(dir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ claude: [
      { id: 'declared', configDir: null, overageEnabled: false },
      { id: 'unknown', configDir: '/tmp/.claude-unknown' },
    ] }));
    const tap = (used: number) => ({ rate_limits: { five_hour: { used_percentage: used, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 });
    writeFileSync(join(dir, 'claude.json'), JSON.stringify(tap(12)));
    writeFileSync(join(dir, 'claude-declared.json'), JSON.stringify(tap(100)));
    writeFileSync(join(dir, 'claude-unknown.json'), JSON.stringify(tap(100)));
    const caps = readProviderCaps({ usageDir: dir, accountsPath, nowS }).claude.accounts;
    expect(caps.find((account) => account.id === 'declared')).toMatchObject({ overageEnabled: false, overageSpend: null });
    expect(caps.find((account) => account.id === 'unknown')).toMatchObject({ overageEnabled: null, overageSpend: null });
  });

  it('parses a Cursor row whose detail.onDemand is null without crashing, and keeps other providers (finding 2)', () => {
    // typeof null === 'object', so a bare typeof guard would pass then throw on `.enabled`, taking the
    // WHOLE mirror read down and starving every provider of caps — the incident's silent-billing path.
    const dir = tempDir(); const nowS = writtenAt + 10;
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS - 5,
      limits: [
        { provider: 'cursor', capturedAt: nowS - 5, staleAfterSecs: 3600,
          accounts: [{ id: 'cursor-ide', detail: { onDemand: null }, fiveHour: { usedPercentage: null, resetsAt: null } }] },
        { provider: 'claude', capturedAt: nowS - 5, staleAfterSecs: 3600, fiveHour: { usedPercentage: 40, resetsAt: null },
          accounts: [{ id: 'acct1', fiveHour: { usedPercentage: 40, resetsAt: null } }] },
      ],
    }));
    const caps = readLimitsMirror(dir, nowS)!;
    expect(caps.cursor.accounts[0]).toMatchObject({ id: 'cursor-ide', overageEnabled: null, overageSpend: null });
    expect(caps.claude.fiveHour.usedPercentage).toBe(40); // one bad row must not starve other providers
  });

  it('a payload overage posture wins over an operator declaration (precedence, finding 5)', () => {
    const dir = tempDir(); const nowS = writtenAt + 10;
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ cursor: [{ id: 'cursor-ide', overageEnabled: true }] }));
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS - 5,
      limits: [{ provider: 'cursor', capturedAt: nowS - 5, staleAfterSecs: 3600,
        accounts: [{ id: 'cursor-ide', detail: { onDemand: { enabled: false, used: 0 } }, fiveHour: { usedPercentage: null, resetsAt: null } }] }],
    }));
    const caps = readProviderCaps({ usageDir: dir, accountsPath: join(dir, 'accounts.json'), nowS });
    expect(caps.cursor.accounts[0]).toMatchObject({ overageEnabled: false, overageSpend: 0 }); // payload false beats declared true
  });

  it('treats old, corrupt, missing, and malformed mirrors as unknown', () => {
    const dir = tempDir(); copyFileSync(fixture, join(dir, 'limits.json'));
    expect(readLimitsMirror(dir, writtenAt + 10_000)).toBeNull();
    writeFileSync(join(dir, 'limits.json'), '{not json'); expect(readLimitsMirror(dir, writtenAt + 10)).toBeNull();
    expect(readLimitsMirror(tempDir(), writtenAt + 10)).toBeNull();
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({ writtenAt, limits: 'nope' }));
    expect(readLimitsMirror(dir, writtenAt + 10)).toBeNull();
  });

  it('normalizes a window that has reset into a fresh zero-percent window', () => {
    const dir = tempDir(); const nowS = writtenAt + 10;
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({ writtenAt, limits: [{ provider: 'claude', fiveHour: { usedPercentage: 80, resetsAt: nowS - 5 } }] }));
    expect(readLimitsMirror(dir, nowS)?.claude.fiveHour).toEqual({ usedPercentage: 0, resetsAt: nowS - 5 });
  });

  it('reads the Claude tap main snapshot and marks stale account snapshots unusable', () => {
    const dir = tempDir(); const nowS = writtenAt + 10;
    const tap = (used: number, capturedAt = nowS - 30) => ({ model: 'claude-fable-5', rate_limits: { five_hour: { used_percentage: used, resets_at: nowS + 3600 }, seven_day: { used_percentage: 21, resets_at: nowS + 86400 } }, capturedAt });
    writeFileSync(join(dir, 'claude.json'), JSON.stringify(tap(15))); writeFileSync(join(dir, 'claude-acct2.json'), JSON.stringify(tap(60))); writeFileSync(join(dir, 'claude-acct3.json'), JSON.stringify(tap(40, nowS - 99999)));
    const caps = readClaudeTap(dir, nowS)!;
    expect(caps).toMatchObject({ source: 'claude-tap', stale: false }); expect(caps.fiveHour.usedPercentage).toBe(15);
    expect(caps.accounts.map((a) => a.id).sort()).toEqual(['acct2', 'acct3']);
    expect(caps.accounts.find((a) => a.id === 'acct2')).toMatchObject({ stale: false, fiveHour: { usedPercentage: 60 } });
    expect(caps.accounts.find((a) => a.id === 'acct3')).toMatchObject({ stale: true, fiveHour: { usedPercentage: null }, noteCodes: ['claude.noCapture'] });
    expect(readClaudeTap(tempDir(), nowS)).toBeNull();
  });

  it('returns an account-only stale Claude tap when the main snapshot is absent', () => {
    const dir = tempDir(); const nowS = writtenAt + 10;
    writeFileSync(join(dir, 'claude-acct2.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 60, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    expect(readClaudeTap(dir, nowS)).toMatchObject({ source: 'claude-tap', stale: true, accounts: [expect.objectContaining({ id: 'acct2' })] });
  });

  it('prefers a fresh mirror while merging Claude tap account rows', () => {
    const dir = tempDir(); const nowS = writtenAt + 10; copyFileSync(fixture, join(dir, 'limits.json'));
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 15, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    writeFileSync(join(dir, 'claude-acct2.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 60, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    const caps = readProviderCaps({ usageDir: dir, nowS });
    expect(caps.claude).toMatchObject({ source: 'limits.json', fiveHour: { usedPercentage: 32 }, accounts: [expect.objectContaining({ id: 'acct2' })] });
  });

  it('falls back to a fresh Claude tap when the mirror is stale and exposes unknown providers for an empty directory', () => {
    const dir = tempDir(); copyFileSync(fixture, join(dir, 'limits.json'));
    const nowS = writtenAt + 10_000;
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 15, resets_at: nowS + 3600 } }, capturedAt: nowS - 30 }));
    const fromTap = readProviderCaps({ usageDir: dir, nowS });
    expect(fromTap.claude).toMatchObject({ source: 'claude-tap', fiveHour: { usedPercentage: 15 } });
    for (const provider of ['codex', 'cursor', 'gemini']) expect(fromTap[provider]).toMatchObject({ source: 'none', stale: true });
    const empty = readProviderCaps({ usageDir: tempDir(), nowS });
    for (const provider of ['claude', 'codex', 'cursor', 'gemini']) expect(empty[provider]).toMatchObject({ source: 'none', stale: true });
  });

  it('selects the five-hour window before seven-day and rejects unknown or stale caps', () => {
    const dir = tempDir(); copyFileSync(fixture, join(dir, 'limits.json')); const mirror = readLimitsMirror(dir, writtenAt + 10)!;
    expect(bindingWindow(mirror.claude)).toMatchObject({ name: '5h', window: { usedPercentage: 32 } });
    expect(bindingWindow(mirror.codex)).toMatchObject({ name: '7d', window: { usedPercentage: 5 } });
    expect(bindingWindow({ ...mirror.claude, source: 'none' })).toBeNull(); expect(bindingWindow({ ...mirror.claude, stale: true })).toBeNull();
  });
});

describe('readClaudeTap — window-keeper anchors', () => {
  it('treats a live keeper anchor as a fresh ~0% capture for an account the tap has never seen, and lets a fresher tap win', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readClaudeTap } = await import('../src/usage.js');
    const dir = mkdtempSync(join(tmpdir(), 'heddle-keeper-'));
    try {
      const nowS = 1_800_000_000;
      // acct3: only a keeper anchor (window started 10 min ago, resets in 4h50m)
      writeFileSync(join(dir, 'claude-acct3.keeper.json'), JSON.stringify({ account: 'acct3', startedAt: nowS - 600, resets_at: nowS + 17_400, used: null, source: 'keeper-ping' }));
      // acct2: an OLD tap file (2h) and a NEWER keeper anchor (5 min) → keeper wins
      writeFileSync(join(dir, 'claude-acct2.json'), JSON.stringify({ model: 'claude-fable-5', rate_limits: { five_hour: { used_percentage: 40, resets_at: nowS + 3600 }, seven_day: { used_percentage: 10, resets_at: nowS + 86400 } }, capturedAt: nowS - 7200 }));
      writeFileSync(join(dir, 'claude-acct2.keeper.json'), JSON.stringify({ account: 'acct2', startedAt: nowS - 300, resets_at: nowS + 17_700, used: null, source: 'keeper-ping' }));
      // acct1: fresh tap (1 min) and an older keeper anchor → tap wins
      writeFileSync(join(dir, 'claude-acct1.json'), JSON.stringify({ model: 'claude-fable-5', rate_limits: { five_hour: { used_percentage: 64, resets_at: nowS + 3000 }, seven_day: { used_percentage: 21, resets_at: nowS + 80000 } }, capturedAt: nowS - 60 }));
      writeFileSync(join(dir, 'claude-acct1.keeper.json'), JSON.stringify({ account: 'acct1', startedAt: nowS - 900, resets_at: nowS + 17_100, used: null, source: 'keeper-ping' }));
      // acct4: a keeper anchor whose window already rolled over → unknown
      writeFileSync(join(dir, 'claude-acct4.keeper.json'), JSON.stringify({ account: 'acct4', startedAt: nowS - 20_000, resets_at: nowS - 2000, used: null, source: 'keeper-ping' }));
      const caps = readClaudeTap(dir, nowS)!;
      const by = Object.fromEntries(caps.accounts.map((a) => [a.id, a]));
      expect(Object.keys(by).sort()).toEqual(['acct1', 'acct2', 'acct3', 'acct4']);
      expect(by.acct3).toMatchObject({ stale: false, fiveHour: { usedPercentage: 0, resetsAt: nowS + 17_400 }, noteCodes: ['claude.keeperAnchor'] });
      expect(by.acct2).toMatchObject({ stale: false, fiveHour: { usedPercentage: 0, resetsAt: nowS + 17_700 }, noteCodes: ['claude.keeperAnchor'] });
      expect(by.acct1).toMatchObject({ stale: false, fiveHour: { usedPercentage: 64 }, noteCodes: [] });
      expect(by.acct4).toMatchObject({ stale: true, fiveHour: { usedPercentage: null }, noteCodes: ['claude.noCapture'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
