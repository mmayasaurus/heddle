import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('redacts credential shapes in shapes-only mode while preserving long opaque filenames', () => {
    const sk = 'sk-' + 'DEADBEEF1234567890';
    const glm = 'abcdef0123456789abcdef0123456789.abcdef0123456789';
    const bearer = 'Bearer ' + 'tok1234567890';
    const github = 'gh' + 'p_EXAMPLE000000000000000000000000';
    const akia = 'AKIA' + 'IOSFODNN7EXAMPLE';

    for (const value of [sk, glm, bearer, github, akia]) {
      expect(redactSecrets(value, { shapesOnly: true })).toContain('[redacted]');
    }

    for (const filename of [
      'release-20260915-build-artifact.txt',
      'a1b2c3d4e5f6a1b2c3d4e5f6',
    ]) {
      expect(redactSecrets(filename, { shapesOnly: true })).toBe(filename);
      expect(redactSecrets(filename)).toContain('[redacted]');
    }
  });

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

  // Round-5 finding (codex/gpt-5.6-sol): the AWS access-key-id shape (A[KS]IA + 16) is exactly 20 chars, so
  // it DODGES the 24+ opaque backstop and needs its own prefix arm. Split literals keep gitleaks' AWS
  // access-key rule off the shipped test file (AWS's own docs-example id).
  it('redacts a bare AWS access key id and one in an AWS_ACCESS_KEY_ID= assignment', () => {
    const akia = 'AKIA' + 'IOSFODNN7EXAMPLE'; // 20-char AWS access key id (AWS docs example), split literal
    expect(redactSecrets(akia)).toBe('[redacted]');
    expect(redactSecrets(`AWS_ACCESS_KEY_ID=${akia}`)).toBe('AWS_ACCESS_KEY_ID=[redacted]');
    const asia = 'ASIA' + 'IOSFODNN7EXAMPLE'; // STS temporary access key id
    expect(redactSecrets(`stderr: ${asia} denied`)).toBe('stderr: [redacted] denied');
  });

  // Accepted residual (round 5): an AWS SECRET key is 40-char base64. A slashless one is caught by the opaque
  // 24+ rule; a '/'-containing one is NOT — and cannot be safely, since a '/'-inclusive rule would redact
  // long real filesystem paths (which MUST survive). Documented — same class as the prefix-less-opaque residual.
  it('catches a slashless AWS secret via opaque yet leaves a long alnum+slash path intact', () => {
    const noSlash = 'wJalrXUtnFEMIK7MDENGbPxRfiCYE' + 'XAMPLEKEY12'; // 40 chars, no slash -> opaque catches
    expect(redactSecrets(noSlash)).toBe('[redacted]');
    const longPath = '/usr/local/share/applications/mycompanyapp/bin'; // 40+ alnum+slash path MUST survive
    expect(redactSecrets(longPath)).toBe(longPath);
  });

  it('is ReDoS-safe: ~0.5MB pathological runs redact well under a second', () => {
    const start = Date.now();
    for (const s of [
      'a'.repeat(500_000),                                   // no match
      'http://' + 'a'.repeat(300_000),                       // unbounded userinfo, no '@'
      'secret'.repeat(80_000),                               // repeated embedded keyword
      'x'.repeat(200_000) + '.' + 'y'.repeat(200_000),       // dotted pair
      'g' + 'sk_' + 'a'.repeat(300_000),                     // credential-prefix arm, unbounded suffix
      'AKIA' + 'A'.repeat(300_000),                          // AWS access-key arm, unbounded {16,} suffix
    ]) redactSecrets(s);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

// HED-651 qodo HIGH: shapes-only turns the opaque backstop OFF, so a recognized credential DECORATED
// into a filename (backup_sk-…, notes_lin_api_…) slips the \b-anchored shared prefix rule and the _-
// excluding GLM lookbehind. The supplementary embedded pass must catch it. Each fixture LEAKS on the
// pre-fix HEAD and is load-bearing on the else branch. Split literals keep the shipped source free of
// scannable credential shapes (public-scrub convention — same split points as scrub.ts / the cases above).
describe('redactSecrets — shapes-only decorated credentials (HED-651)', () => {
  const S = (t: string) => redactSecrets(t, { shapesOnly: true });

  it('redacts a recognized credential decorated into a filename, across prefix arms and decorations', () => {
    // Porcelain-prefixed exactly as escapedPaths()/destroyedWork() emit them ("<status> <path>").
    const cases: [string, string][] = [
      ['?? backup_' + 'sk-' + 'DEADBEEF1234567890', '?? backup_[redacted]'],   // sk-, underscore-decorated
      ['?? v2' + 'sk-' + 'DEADBEEF1234567890', '?? v2[redacted]'],             // sk-, digit-decorated
      ['?? backup_' + 'gh' + 'p_EXAMPLE000000000000000000000000', '?? backup_[redacted]'],
      ['?? backup_' + 'github_' + 'pat_ABCDEFGHIJKL1234', '?? backup_[redacted]'],
      ['M v2_' + 'g' + 'sk_ABCDEFGHIJKL1234', 'M v2_[redacted]'],
      ['?? my_' + 'c' + 'sk-' + 'ABCDEFGHIJKL1234', '?? my_[redacted]'],
      ['reverted-or-deleted notes_' + 'lin_' + 'api_ABCDEFGHIJKL1234', 'reverted-or-deleted notes_[redacted]'],
      ['?? x_' + 'xox' + 'b-ABCDEFGHIJKL1234', '?? x_[redacted]'],
      ['?? pre_' + 'AKIA' + 'IOSFODNN7EXAMPLE', '?? pre_[redacted]'],
      // GLM <32>.<16> whose left run is _-decorated — the shared lookbehind excludes _ and misses it.
      ['?? backup_abcdef0123456789abcdef0123456789.abcdef0123456789', '?? backup_[redacted]'],
    ];
    for (const [input, want] of cases) {
      const out = S(input);
      expect(out).toBe(want);
      expect(out).not.toContain('DEADBEEF');
      expect(out).not.toContain('ABCDEFGHIJKL');
    }
  });

  it('redacts a GLM key with an over-long contiguous run glued to it — the shapes-only dotted rule is unbounded (no {64} ceiling)', () => {
    // Round-2 adversarial MEDIUM: the shared full-mode GLM rule caps each side at {20,64}; with the opaque
    // backstop OFF, a decorated key whose contiguous alnum run exceeds 64 on either side outran that ceiling
    // and leaked (the lookbehind pins the ONLY valid start at the run head, so backtracking never reaches
    // the dot). Shapes-only lifts the cap to {20,}/{12,}; the pinned start keeps it linear (ReDoS test above).
    const glm = 'abcdef0123456789abcdef0123456789.abcdef0123456789'; // <32>.<16>, scrub/gitleaks-safe
    for (const input of [
      '?? ' + 'p'.repeat(33) + glm, // left run 65 = 33 filler + 32 — leaks on the pre-fix HEAD
      '?? ' + 'p'.repeat(35) + glm, // left run 67
      '?? ' + glm + 'q'.repeat(49), // right run 65 = 16 + 49
      '?? ' + 'p'.repeat(32) + glm, // left run 64 — the ceiling edge, must still redact (no regression)
    ]) {
      const out = S(input);
      expect(out).toBe('?? [redacted]');
      expect(out).not.toContain('abcdef0123456789');
    }
  });

  it('preserves ordinary filenames whose names merely contain an sk-/dotted substring', () => {
    // sk- is a common English substring; the (?<![A-Za-z]) guard keeps letter-preceded words intact.
    for (const f of [
      'task-force-release-20260915-build.md',
      'disk-usage-report-2026.txt',
      'risk-assessment-final.md',
      'desk-setup-notes.md',
      'ask-me-anything.md',
      'config.production.json',
      'notes.readme',
    ]) expect(S('?? ' + f)).toBe('?? ' + f);
  });

  it('full mode is byte-identical: the opaque backstop, not a changed prefix rule, catches the decorated token', () => {
    // The SHARED chain is untouched, so full mode redacts the WHOLE decorated run via the opaque rule →
    // "[redacted]" (a changed shared prefix rule would instead give "backup_[redacted]"). This assertion
    // fails if the shared chain drifts.
    expect(redactSecrets('?? backup_' + 'sk-' + 'DEADBEEF1234567890')).toBe('?? [redacted]');
    expect(redactSecrets('?? backup_' + 'gh' + 'p_EXAMPLE000000000000000000000000')).toBe('?? [redacted]');
  });

  it('accepts the documented residual: a LETTER-decorated recognized prefix (xsk-) reads as an ordinary word in shapes-only, yet full mode still scrubs it', () => {
    // Realistic ~100-char key body so full mode's opaque 24+ backstop actually FIRES — proving the residual
    // is SHAPES-ONLY (letter-decoration reads as a word: no \b precedes the embedded sk-) while the
    // vendor-error path (full mode) still scrubs the whole run. Split literals keep the shipped source
    // free of a scannable sk- shape (public-scrub convention).
    const body = 'ant-api03-' + 'A1b2c3D4e5'.repeat(9); // ~100 chars, obviously synthetic
    const residual = '?? x' + 'sk-' + body;
    expect(S(residual)).toBe(residual);                    // shapes-only: unchanged (accepted residual)
    expect(redactSecrets(residual)).toBe('?? [redacted]'); // full mode: opaque backstop catches it
  });
});
