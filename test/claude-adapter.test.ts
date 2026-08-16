import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, DEFAULT_CLAUDE_ALLOWED_TOOLS, parseClaudeResult } from '../src/adapters/claude.js';

function pair(args: string[], flag: string, value: string): string[] {
  return args.slice(args.indexOf(flag), args.indexOf(flag) + 2).filter(Boolean);
}

function result(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 's1', duration_ms: 1103, num_turns: 1, usage: { input_tokens: 10, output_tokens: 38, cache_read_input_tokens: 0, cache_creation_input_tokens: 5, output_tokens_details: { thinking_tokens: 31 } }, ...overrides });
}

describe('ClaudeAdapter invocation and result contracts', () => {
  it('builds the default headless invocation with the complete safe tool allowlist', () => {
    const args = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp' });
    expect(args.slice(0, 6)).toEqual(['-p', 'do it', '--output-format', 'json', '--model', 'haiku']);
    expect(pair(args, '--permission-mode', 'acceptEdits')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual([...DEFAULT_CLAUDE_ALLOWED_TOOLS]);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('WebFetch');
    expect(args).not.toContain('WebSearch');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('--mcp-config');
    // arbitrary-code launchers stay OUT of the default allowlist (PR #12: four reviewers) — repo
    // workflows go through the npm/npx entries.
    expect(DEFAULT_CLAUDE_ALLOWED_TOOLS).not.toContain('Bash(node:*)');
  });

  it('maps the codex-vocabulary minimal effort to low and passes claude-native efforts through', () => {
    const minimal = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp', effort: 'minimal' });
    expect(pair(minimal, '--effort', 'low')).toEqual(['--effort', 'low']);
    expect(minimal).not.toContain('minimal');
    expect(pair(new ClaudeAdapter().buildArgs('x', { model: 'haiku', cwd: '/tmp', effort: 'xhigh' }), '--effort', 'xhigh')).toEqual(['--effort', 'xhigh']);
  });

  it('allowlists each attached MCP server so headless workers can actually call its tools', () => {
    const args = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp', mcpConfigPath: '/tmp/m.json', mcpServers: ['memtrace'] });
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual([...DEFAULT_CLAUDE_ALLOWED_TOOLS, 'mcp__memtrace']);
    const none = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp' });
    expect(none.join(' ')).not.toContain('mcp__');
  });

  it('orders optional Claude flags before permission flags and keeps extra flags at the end', () => {
    const args = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp', effort: 'high', resume: 'sess-1', systemPromptAppend: 'PACKS', mcpConfigPath: '/tmp/m.json', extraFlags: ['--foo'] });
    expect(pair(args, '--effort', 'high')).toEqual(['--effort', 'high']);
    expect(pair(args, '--resume', 'sess-1')).toEqual(['--resume', 'sess-1']);
    expect(pair(args, '--append-system-prompt', 'PACKS')).toEqual(['--append-system-prompt', 'PACKS']);
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 3)).toEqual(['--mcp-config', '/tmp/m.json', '--strict-mcp-config']);
    expect(args.at(-1)).toBe('--foo');
  });

  it('widens only browsing tools for browse and replaces the posture for privileged execution', () => {
    const browsable = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp', capabilities: ['browse'] });
    expect(browsable.slice(browsable.indexOf('--allowedTools') + 1)).toEqual([...DEFAULT_CLAUDE_ALLOWED_TOOLS, 'WebFetch', 'WebSearch']);
    expect(browsable).toContain('Read');
    const privileged = new ClaudeAdapter().buildArgs('do it', { model: 'haiku', cwd: '/tmp', capabilities: ['exec-privileged'] });
    expect(privileged).toContain('--dangerously-skip-permissions');
    expect(privileged).not.toContain('--permission-mode');
    expect(privileged).not.toContain('--allowedTools');
  });

  it('uses an explicitly configured tool allowlist without silently appending defaults', () => {
    const args = new ClaudeAdapter({ allowedTools: ['Read'] }).buildArgs('do it', { model: 'haiku', cwd: '/tmp' });
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Read']);
  });

  it('parses Claude success JSON into the normalized worker result and preserves the raw payload', () => {
    const raw = JSON.parse(result());
    expect(parseClaudeResult(JSON.stringify(raw), 0)).toEqual({ ok: true, output: 'OK', sessionId: 's1', durationMs: 1103, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 38, reasoningOutputTokens: 31 }, exitCode: 0, error: undefined, raw });
  });

  it('rejects empty stdout, malformed output, error payloads, bad subtypes, bad exits, and empty results', () => {
    expect(parseClaudeResult('', 0)).toMatchObject({ ok: false, error: expect.stringContaining('no stdout') });
    expect(parseClaudeResult('garbage', 0)).toMatchObject({ ok: false, error: expect.stringContaining('no result JSON') });
    expect(parseClaudeResult(result({ is_error: true }), 0)).toMatchObject({ ok: false, error: expect.stringContaining('is_error=true') });
    expect(parseClaudeResult(result({ subtype: 'error_max_turns' }), 0).ok).toBe(false);
    expect(parseClaudeResult(result(), 1).ok).toBe(false);
    expect(parseClaudeResult(result({ result: '' }), 0)).toMatchObject({ ok: false, error: expect.stringContaining('empty result') });
    // A MISSING/null result field is empty output too — stringifying it would fabricate '""'/'null'
    // and slip past the empty-result check (PR #12: codacy + copilot).
    expect(parseClaudeResult(result({ result: undefined }), 0)).toMatchObject({ ok: false, output: '', error: expect.stringContaining('empty result') });
    expect(parseClaudeResult(result({ result: null }), 0)).toMatchObject({ ok: false, output: '' });
  });

  it('finds a result JSON line after noise and serializes non-string result content', () => {
    expect(parseClaudeResult(`warning: x\n${result()}`, 0)).toMatchObject({ ok: true, output: 'OK' });
    expect(parseClaudeResult(result({ result: { a: 1 } }), 0)).toMatchObject({ ok: true, output: JSON.stringify({ a: 1 }) });
  });
});
