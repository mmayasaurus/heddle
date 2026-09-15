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
      // The confinement/destroyed-work warnings join real filenames into the persisted ledger error;
      // redacting that string at the boundary must leave ordinary filenames intact.
      'escape-warning: 2 change(s): src/dispatcher/run.ts, replies-r2.json',
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

// PR #220 review hardening (qodo/codacy + adversarial codex review).
describe('redactSecrets — review-hardened cases', () => {
  it('redacts a non-Bearer Authorization header of any scheme, including a short Basic value', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: [redacted]');
    expect(redactSecrets('Authorization: Basic abc')).toBe('Authorization: [redacted]');
  });

  it('redacts credentials in a URL userinfo but leaves a port-only URL alone', () => {
    expect(redactSecrets('curl https://user:pAssw0rd@host.example/x failed'))
      .toBe('curl https://[redacted]@host.example/x failed');
    const portOnly = 'GET https://host.example:8080/v1 -> 500';
    expect(redactSecrets(portOnly)).toBe(portOnly);
  });

  it('redacts an entire PEM key block', () => {
    // Split the PEM markers so the shipped source carries no scannable private-key block (gitleaks
    // private-key rule); the runtime value is a full block (with +/ base64 chars) for the redactor.
    const pem = ['-----BEGIN ' + 'PRIVATE KEY-----', 'ZmFrZS1ib2R5+line/x', 'c2hvcnQ=', '-----END ' + 'PRIVATE KEY-----'].join('\n');
    expect(redactSecrets(pem)).toBe('[redacted]');
  });

  it('redacts a value whose key NAME embeds a sensitive word (aws_secret_access_key=), slashes and all', () => {
    expect(redactSecrets('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key=[redacted]');
  });

  it('redacts a quoted JSON secret value (short — only the assignment rule can catch it)', () => {
    expect(redactSecrets('{"api_key": "hunter2"}')).not.toContain('hunter2');
    expect(redactSecrets('{"password":"s3"}')).not.toContain('s3');
  });

  it('redacts a BARE dotted GLM key as a unit — no surviving 16-char tail', () => {
    const glm = 'abcdef0123456789abcdef0123456789.abcdef0123456789';
    const out = redactSecrets(`failed with ${glm}`);
    expect(out).toBe('failed with [redacted]');
    expect(out).not.toContain('abcdef0123456789');
  });

  // Fresh-adversarial-review round (codex/gpt-5.6-sol @5765564): long URL password, long embedded-key
  // suffix, and multi-param Digest.
  it('redacts an arbitrarily long URL userinfo password (unbounded, no fixed cap)', () => {
    const pw = 'p'.repeat(300);
    const out = redactSecrets(`https://user:${pw}@example.com/x`);
    expect(out).toBe('https://[redacted]@example.com/x');
    expect(out).not.toContain(pw);
  });

  it('redacts the value when a sensitive keyword is embedded mid-key with a long suffix', () => {
    expect(redactSecrets('MY_SECRET_ACCESS_TOKEN_HANDLE=hunter2')).not.toContain('hunter2');
  });

  it('redacts the sensitive params of a multi-param Authorization header (Digest)', () => {
    const h = 'Authorization: Digest username="x", realm="r", nonce="EXAMPLE00000000000000000000000000", response="EXAMPLE11111111111111111111111111"';
    const out = redactSecrets(h);
    expect(out).not.toContain('EXAMPLE00000000000000000000000000');
    expect(out).not.toContain('EXAMPLE11111111111111111111111111');
  });

  // Finding 2 (round-4, cursor/grok): the credential-PREFIX rule now matches scrub.ts's full
  // credentialPatterns set, so a BARE heddle-provider token (no key=value context, too short/dot-free for
  // the opaque rule) is redacted by shape alone. Split literals keep the shipped test file clear of
  // scannable credentials (public-scrub + gitleaks convention — same split points scrub.ts uses).
  it('redacts bare provider tokens for every scrub.ts credential prefix', () => {
    const bare = [
      'g' + 'sk_' + 'EXAMPLE0123456789abcdef',        // Groq
      'c' + 'sk-' + 'EXAMPLE0123456789abcdef',        // Cerebras
      'lin_' + 'api_' + 'EXAMPLE0123456789abcdef',    // Linear API
      'lin_' + 'oauth_' + 'EXAMPLE0123456789abcdef',  // Linear OAuth
      'github_' + 'pat_' + 'EXAMPLE0123456789abcdef', // GitHub fine-grained PAT
    ];
    for (const token of bare) {
      const out = redactSecrets(`worker stderr tail: ${token}`);
      expect(out).toBe('worker stderr tail: [redacted]');
      expect(out).not.toContain(token);
    }
  });

  // Finding 3 (round-4): the dotted-pair lookbehind excludes A-Za-z0-9_- but NOT '/', so a path/URL-nested
  // GLM <32>.<16> key is caught (previously a leading '/' blocked BOTH the dotted and opaque rules).
  it('redacts a path-nested dotted GLM key (a leading slash no longer shields it)', () => {
    const glm = 'abcdef0123456789abcdef0123456789.abcdef0123456789'; // <32>.<16>, scrub/gitleaks-safe
    const out = redactSecrets(`error loading src/${glm}`);
    expect(out).toBe('error loading src/[redacted]');
    expect(out).not.toContain('abcdef0123456789');
  });

  // Accepted tradeoff of finding 3's lookbehind relaxation: a long dotted hostname label (>=20 . >=12) now
  // over-redacts. Over-redaction is the safe direction (R msg 2266); ordinary short-label hosts are unaffected.
  it('over-redacts a long dotted hostname label — the accepted finding-3 direction', () => {
    const out = redactSecrets('GET https://longsubdomainlabel123.exampledomainname/v1 -> 500');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('longsubdomainlabel123.exampledomainname');
    // a normal short-label host is untouched (labels sit well under the 20/12 floors)
    expect(redactSecrets('GET https://api.example.com/v1 -> 500')).toBe('GET https://api.example.com/v1 -> 500');
  });

  // Opaque backstop on the vendor-error path (full redaction, run.ts:337): a prefix-less 24+ token with a
  // digit is scrubbed. This is the sole rule the reverted escape/destroyed-note handling never routes
  // through (those notes are persisted verbatim; scrubbing them safely is HED-651).
  it('redacts a prefix-less opaque token on the full-redaction path', () => {
    expect(redactSecrets('deadbeef0123456789abcdef01')).toBe('[redacted]');
  });

  it('is ReDoS-safe: ~0.5MB pathological runs redact well under a second', () => {
    const start = Date.now();
    for (const s of [
      'a'.repeat(500_000),                                   // no match
      'http://' + 'a'.repeat(300_000),                       // unbounded userinfo, no '@'
      'secret'.repeat(80_000),                               // repeated embedded keyword
      'x'.repeat(200_000) + '.' + 'y'.repeat(200_000),       // dotted pair
      'g' + 'sk_' + 'a'.repeat(300_000),                     // credential-prefix arm, unbounded suffix
    ]) redactSecrets(s);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
