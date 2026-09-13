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
const baseRun = { stderr: '', exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false };
const cursorOutput = JSON.stringify({ type: 'result', is_error: false, result: 'cursor response', session_id: 'cursor-session', usage: { inputTokens: 1, outputTokens: 1 } });
const claudeOutput = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude response', session_id: 'claude-session', usage: { input_tokens: 1, output_tokens: 1 } });
const codexOutput = [
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex response' } }),
].join('\n');
const agyOutput = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'agy response', conversation_id: 'agy-session', usage: { input_tokens: 1, output_tokens: 1 } } });

describe('subprocess adapter truncation handling', () => {
  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s turns an otherwise successful truncated stream into a failure', async (_name, adapter, stdout, options) => {
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, stdoutTruncated: true, stderrTruncated: false });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('truncated');
    expect(result.exitCode).toBe(0);
    expect(result.raw).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s preserves successful parsing when the stream is not truncated', async (_name, adapter, stdout, options) => {
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, stdoutTruncated: false, stderrTruncated: false });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(true);
  });

  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s preserves successful parsing when only stderr is truncated', async (_name, adapter, stdout, options) => {
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, stdoutTruncated: false, stderrTruncated: true });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(true);
  });

  it.each([
    ['cursor', new CursorAdapter(), cursorOutput, { model: 'kimi-k3', cwd: '/tmp' }],
    ['claude', new ClaudeAdapter(), claudeOutput, { model: 'sonnet', cwd: '/tmp' }],
    ['codex', new CodexAdapter(), codexOutput, { model: 'gpt-5.6-terra', cwd: '/tmp' }],
    ['agy', new AgyAdapter(), agyOutput, { model: 'gemini-3.6-flash-low', cwd: '/tmp' }],
  ] as const)('%s attaches the stderr tail when a truncated success carries stderr diagnostics', async (_name, adapter, stdout, options) => {
    // A truncated stdout that STILL parsed to success has no error of its own, so failIfTruncated
    // must surface the stderr tail as the only diagnostic (round-1 finding B). Guards that branch:
    // without it the error would be the truncation note alone and this assertion would fail.
    mockedRun.mockResolvedValueOnce({ ...baseRun, stdout, stdoutTruncated: true, stderrTruncated: false, stderr: 'diag-from-cli' });

    const result = await adapter.dispatch('work', options);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stderr tail: diag-from-cli');
  });
});
