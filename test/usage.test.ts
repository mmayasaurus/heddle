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
    expect(caps.cursor.accounts[0]).toMatchObject({ id: 'cursor-ide', noteCodes: expect.arrayContaining(['cursor.includedApiExhausted']) });
    expect(caps.gemini.fiveHour.usedPercentage).toBeCloseTo(3.93);
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
