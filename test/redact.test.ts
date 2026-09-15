import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('redacts recognized credential shapes', () => {
    const authorization = 'Authorization: Bearer sk-ant-EXAMPLE0000';
    const github = 'provider failed with ghp_EXAMPLE000000000000000000000000';
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
});
