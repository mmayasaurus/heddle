import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOperatorMode, writeOperatorMode, isOperatorMode,
  DEFAULT_OPERATOR_MODE, OPERATOR_MODES,
} from '../src/operator-mode.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'opmode-')), 'operator-mode.json');
}

describe('operator-mode (HED-336 S1a)', () => {
  it('reads the desktop default when the file is absent — never escalates on missing state', () => {
    expect(readOperatorMode(tmpPath())).toEqual({ mode: 'desktop', since: null, note: null });
  });

  it('round-trips a written mode with since + note', () => {
    const path = tmpPath();
    const written = writeOperatorMode('mobile', 'school run', path, new Date('2026-08-28T12:00:00.000Z'));
    expect(written).toEqual({ mode: 'mobile', since: '2026-08-28T12:00:00.000Z', note: 'school run' });
    expect(readOperatorMode(path)).toEqual(written);
  });

  it('defaults note to null and stamps since from the injected now', () => {
    const path = tmpPath();
    expect(writeOperatorMode('away', null, path, new Date('2026-01-01T00:00:00.000Z')))
      .toEqual({ mode: 'away', since: '2026-01-01T00:00:00.000Z', note: null });
  });

  it('degrades to desktop on malformed JSON (hot-path read must never throw)', () => {
    const path = tmpPath();
    writeFileSync(path, '{ not json', 'utf8');
    expect(readOperatorMode(path)).toEqual({ mode: 'desktop', since: null, note: null });
  });

  it('degrades to desktop on an unknown mode string — never silently escalates to mobile/away', () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ mode: 'sleep', since: 'x', note: 'y' }), 'utf8');
    expect(readOperatorMode(path).mode).toBe('desktop');
  });

  it('validates the mode enum', () => {
    expect(OPERATOR_MODES.every(isOperatorMode)).toBe(true);
    expect(isOperatorMode('desktop')).toBe(true);
    expect(isOperatorMode('phone')).toBe(false);
    expect(isOperatorMode(null)).toBe(false);
    expect(isOperatorMode(3)).toBe(false);
    expect(DEFAULT_OPERATOR_MODE).toBe('desktop');
  });

  it('writes valid JSON with a trailing newline and leaves no .tmp behind (atomic rename)', () => {
    const path = tmpPath();
    writeOperatorMode('mobile', null, path, new Date('2026-08-28T12:00:00.000Z'));
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).mode).toBe('mobile');
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('writes the state file 0600 — presence + note are private (owner-only)', () => {
    const path = tmpPath();
    writeOperatorMode('away', 'school run', path, new Date('2026-08-28T12:00:00.000Z'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
