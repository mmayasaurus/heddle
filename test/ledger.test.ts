import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';

/**
 * Ledger round-trip against a TEMP database. Pattern for every test that touches the ledger:
 * construct `new Ledger(<temp path>)` — never the default (~/.heddle/ledger.db is the operator's
 * real dispatch history and the dashboard reads it live).
 */
function startRow(ledger: Ledger, over: Partial<Parameters<Ledger['start']>[0]> = {}): number {
  return ledger.start({
    orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: 'worker-role', issue: 'HED-17', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null, ...over,
  });
}

describe('Ledger (temp db)', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-ledger-test-');
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = tempDir();
    ledger = trackLedger(new Ledger(join(dir, 'ledger.db')));
  });

  it('a started dispatch is in flight until finished, then carries the outcome', () => {
    const id = startRow(ledger);
    expect(ledger.inFlight().map((r) => r.id)).toEqual([id]);

    ledger.finish(id, { ok: true, sessionId: 'thread-1', durationMs: 1234, inputTokens: 10, outputTokens: 5 });

    expect(ledger.inFlight()).toEqual([]);
    const [row] = ledger.recent(1);
    expect(row.id).toBe(id);
    expect(row.ok).toBe(1);
    expect(row.session_id).toBe('thread-1');
    expect(row.duration_ms).toBe(1234);
    expect(row.input_tokens).toBe(10);
    expect(row.output_tokens).toBe(5);
    expect(row.finished_at).toBeTruthy();
  });

  it('a failed dispatch records ok=0 and the error text', () => {
    const id = startRow(ledger);
    ledger.finish(id, { ok: false, error: 'codex produced no stdout' });
    const [row] = ledger.recent(1);
    expect(row.ok).toBe(0);
    expect(row.error).toBe('codex produced no stdout');
  });

  it('finish() keeps a resume handle recorded at start when the outcome has none', () => {
    const id = startRow(ledger, { sessionId: 'resumed-from' });
    ledger.finish(id, { ok: true });
    expect(ledger.recent(1)[0].session_id).toBe('resumed-from');
  });

  it('recent() filters by issue and orders newest first', () => {
    const a = startRow(ledger, { issue: 'HED-1' });
    const b = startRow(ledger, { issue: 'HED-2' });
    const c = startRow(ledger, { issue: 'HED-1' });
    expect(ledger.recent(10).map((r) => r.id)).toEqual([c, b, a]);
    expect(ledger.recent(10, 'HED-1').map((r) => r.id)).toEqual([c, a]);
  });

  it('truncates the prompt preview to 500 chars so a giant prompt never bloats the ledger', () => {
    startRow(ledger, { promptPreview: 'x'.repeat(5000) });
    expect(String(ledger.recent(1)[0].prompt_preview).length).toBe(500);
  });

  it('usageByProvider aggregates per provider', () => {
    ledger.finish(startRow(ledger, { provider: 'codex' }), { ok: true, inputTokens: 100, outputTokens: 10 });
    ledger.finish(startRow(ledger, { provider: 'codex' }), { ok: false, inputTokens: 50 });
    ledger.finish(startRow(ledger, { provider: 'cursor', model: 'composer-2.5' }), { ok: true, outputTokens: 7 });
    const rows = ledger.usageByProvider();
    const codex = rows.find((r) => r.provider === 'codex')!;
    const cursor = rows.find((r) => r.provider === 'cursor')!;
    expect(codex.dispatches).toBe(2);
    expect(codex.succeeded).toBe(1);
    expect(codex.input_tokens).toBe(150);
    expect(cursor.output_tokens).toBe(7);
  });
});
