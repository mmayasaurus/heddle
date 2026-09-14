import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaudeResult } from '../src/adapters/claude.js';

describe('Claude stream-json result parsing', () => {
  it('extracts the terminal result record from the real stream-json capture', () => {
    const fixture = readFileSync(new URL('./fixtures/claude-stream-json-result.ndjson', import.meta.url), 'utf8');
    const terminal = JSON.parse(fixture.trim().split(/\r?\n/).at(-1)!);
    const parsed = parseClaudeResult(fixture, 0);

    expect(parsed.ok).toBe(true);
    expect(parsed.output).toBe(terminal.result);
    expect(parsed.sessionId).toBe(terminal.session_id);
    expect(parsed.usage?.inputTokens).toBe(terminal.usage.input_tokens);
    expect(parsed.usage?.outputTokens).toBe(terminal.usage.output_tokens);
  });
});
