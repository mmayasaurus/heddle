import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';

function startRow(ledger: Ledger): number {
  return ledger.start({
    orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: 'worker-role', issue: 'HED-23', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null,
  });
}

describe('Ledger output persistence (temp db)', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-ledger-output-test-');
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = tempDir();
    ledger = trackLedger(new Ledger(join(dir, 'ledger.db')));
  });

  it('stores a portable output filename and returns its content through getWithOutput', () => {
    const id = startRow(ledger);
    const output = '# Result\n\nImplemented the change.';

    ledger.finish(id, { ok: true, output });

    const row = ledger.get(id)!;
    const outputPath = row.output_path as string;
    expect(isAbsolute(outputPath)).toBe(false);
    expect(outputPath).not.toContain(sep);
    expect(existsSync(join(dir, 'outputs', outputPath))).toBe(true);
    expect(readFileSync(join(dir, 'outputs', outputPath), 'utf8')).toBe(output);
    expect(ledger.getWithOutput(id)).toEqual({ ...row, output });
  });

  it('persists output from a failed dispatch', () => {
    const id = startRow(ledger);
    const output = 'Timed out after completing the migration.';

    ledger.finish(id, { ok: false, error: 'timeout', output });

    expect(ledger.getWithOutput(id)).toMatchObject({ id, ok: 0, error: 'timeout', output });
  });

  it('does not create an output file for whitespace-only output', () => {
    const id = startRow(ledger);

    ledger.finish(id, { ok: true, output: ' \n\t ' });

    expect(ledger.get(id)!.output_path).toBeNull();
    expect(ledger.getWithOutput(id)).toMatchObject({ id, output: null });
    expect(existsSync(join(dir, 'outputs', `${id}.md`))).toBe(false);
  });

  it('returns null output when a persisted output file is later missing', () => {
    const id = startRow(ledger);
    ledger.finish(id, { ok: true, output: 'recoverable result' });
    unlinkSync(join(dir, 'outputs', ledger.get(id)!.output_path as string));

    expect(() => ledger.getWithOutput(id)).not.toThrow();
    expect(ledger.getWithOutput(id)).toMatchObject({ id, output: null });
  });

  it('round-trips markdown, unicode, and newlines byte-identically', () => {
    const id = startRow(ledger);
    const output = '# Café \u{1F680}\n\n- `const answer = "✓"`\n- 中文\n';

    ledger.finish(id, { ok: true, output });

    expect(ledger.getWithOutput(id)?.output).toBe(output);
  });

  it('preserves existing output when finish is called again without it', () => {
    const id = startRow(ledger);
    const output = 'first worker result';
    ledger.finish(id, { ok: true, output });
    const outputPath = ledger.get(id)!.output_path;

    ledger.finish(id, { ok: true });

    expect(ledger.get(id)!.output_path).toBe(outputPath);
    expect(ledger.getWithOutput(id)).toMatchObject({ id, output });
  });

  it('creates output files readable only by their owner', () => {
    const id = startRow(ledger);

    ledger.finish(id, { ok: true, output: 'private worker result' });

    const outputPath = ledger.get(id)!.output_path as string;
    expect(statSync(join(dir, 'outputs', outputPath)).mode & 0o777).toBe(0o600);
  });

  it('finishes the row and cleans up temp output when rename fails', () => {
    const id = startRow(ledger);
    const outputDir = join(dir, 'outputs');
    mkdirSync(join(outputDir, `${id}.md`), { recursive: true });

    ledger.finish(id, { ok: true, output: 'result that cannot be renamed', outputTokens: 23 });

    expect(ledger.get(id)).toMatchObject({ id, ok: 1, output_tokens: 23, output_path: null });
    expect(readdirSync(outputDir)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });
});
