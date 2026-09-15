import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('redacts recognized credential shapes', () => {
    // Split literals so these shipped source lines carry no contiguous credential shape (public-scrub
    // convention — src/release/scrub.ts credentialPatterns); the runtime values are the full tokens.
    const authorization = 'Authorization: Bearer sk-' + 'ant-EXAMPLE0000';
    const github = 'provider failed with gh' + 'p_EXAMPLE000000000000000000000000';
    const apiKey = 'api_key=EXAMPLE000000000000000000000000';

    for (const text of [authorization, github, apiKey]) {
      const redacted = redactSecrets(text);
      expect(redacted).toContain('[redacted]');
      expect(redacted).not.toContain(text.match(/(?:sk-ant-|ghp_|api_key=).+/)?.[0] ?? text);
    }
  });

  it('preserves ordinary prose, code, and filesystem paths', () => {
    for (const text of [
      'worker exited with status 1',
      'const retries = attempts + 1;',
      '/tmp/example-worktree/src/worker.ts',
    ]) expect(redactSecrets(text)).toBe(text);
  });

  it('redacts the exact supplied credential', () => {
    const credential = 'EXAMPLE_CREDENTIAL_VALUE';
    const text = `provider stderr echoed ${credential}`;
    expect(redactSecrets(text, { credential })).toBe('provider stderr echoed [redacted]');
  });

  // Env-var assignment is the most likely stderr leak form, and the keyword is embedded after word
  // chars (ZAI_API_KEY=) so a word-boundary anchor would miss it — leaving a real credential tail.
  it('redacts an env-var assignment whose keyword is embedded after a prefix, tail and all', () => {
    // GLM key shape is `<32>.<16>`: the dot splits the opaque-token heuristic, so without the
    // assignment rule the 16-char tail survives. The whole value must go.
    const glm = 'abcdef0123456789abcdef0123456789.abcdef0123456789';
    const redacted = redactSecrets(`ZAI_API_KEY=${glm}`);
    expect(redacted).toBe('ZAI_API_KEY=[redacted]');
    expect(redacted).not.toContain('abcdef0123456789');
  });

  it('redacts a short env-var secret value that the length heuristic alone would miss', () => {
    // `abc123` is well under the 24-char opaque-token floor: only the keyword=value rule catches it.
    expect(redactSecrets('ACCESS_TOKEN=abc123')).toBe('ACCESS_TOKEN=[redacted]');
  });

  // Documented, accepted false positive (R msg 2266): over-redaction degrades debuggability but never
  // leaks. A 24+ char hyphenated token with a digit (branch names, some UUIDs) trips the catch-all.
  it('over-redacts a long opaque branch-like token — the accepted safe direction', () => {
    expect(redactSecrets('branch hed-588-scrub-error-output failed')).toBe('branch [redacted] failed');
  });
});
