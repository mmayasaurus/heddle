import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';

function startRow(ledger: Ledger): number {
  return ledger.start({
    orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: 'worker-role', issue: 'HED-23', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null,
  });
}

describe('Ledger output persistence (temp db)', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-ledger-output-test-'));
    ledger = new Ledger(join(dir, 'ledger.db'));
  });
  afterEach(() => {
    ledger?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('persists finished output to a file and returns it through getWithOutput', () => {
    const id = startRow(ledger);
    const output = '# Result\n\nImplemented the change.';

    ledger.finish(id, { ok: true, output });

    const row = ledger.get(id)!;
    const outputPath = row.output_path as string;
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toBe(output);
    expect(ledger.getWithOutput(id)).toEqual({ ...row, output });
  });

  it('persists output from a failed dispatch', () => {
    const id = startRow(ledger);
    const output = 'Timed out after completing the migration.';

    ledger.finish(id, { ok: false, error: 'timeout', output });

    expect(ledger.getWithOutput(id)).toMatchObject({ id, ok: 0, error: 'timeout', output });
  });

  it('does not create an output file for empty output', () => {
    const id = startRow(ledger);

    ledger.finish(id, { ok: true, output: ' \n\t ' });

    expect(ledger.get(id)!.output_path).toBeNull();
    expect(ledger.getWithOutput(id)).toMatchObject({ id, output: null });
    expect(existsSync(join(dir, 'outputs', `${id}.md`))).toBe(false);
  });

  it('returns null output when a persisted output file is later missing', () => {
    const id = startRow(ledger);
    ledger.finish(id, { ok: true, output: 'recoverable result' });
    unlinkSync(ledger.get(id)!.output_path as string);

    expect(() => ledger.getWithOutput(id)).not.toThrow();
    expect(ledger.getWithOutput(id)).toMatchObject({ id, output: null });
  });

  it('round-trips markdown, unicode, and newlines byte-identically', () => {
    const id = startRow(ledger);
    const output = '# Café \u{1F680}\n\n- `const answer = "✓"`\n- 中文\n';

    ledger.finish(id, { ok: true, output });

    expect(ledger.getWithOutput(id)?.output).toBe(output);
  });
});
