import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapters/subprocess.js', () => ({
  run: vi.fn(),
  DEFAULT_MAX_STREAM_BYTES: 32 * 1024 * 1024,
}));

import { run } from '../src/adapters/subprocess.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CursorAdapter } from '../src/adapters/cursor.js';

const mockedRun = vi.mocked(run);
const baseRun = { stderr: '', exitCode: 0, timedOut: false };
const cursorOutput = JSON.stringify({ type: 'result', is_error: false, result: 'cursor response' });
const claudeOutput = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude response' });
const codexOutput = [
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex response' } }),
].join('\n');
const agyOutput = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'agy response' } });

describe('subprocess adapter truncation handling', () => {
  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s turns an otherwise successful truncated stream into a failure', async (_name, adapter, stdout, options) => {
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, truncated: true });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('truncated');
  });

  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s preserves successful parsing when the stream is not truncated', async (_name, adapter, stdout, options) => {
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, truncated: false });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(true);
  });
});
