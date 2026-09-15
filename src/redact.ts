/** Remove credential-shaped values from text that may be persisted or returned to callers. */
export function redactSecrets(text: string, opts: { credential?: string } = {}): string {
  try {
    let redacted = text;
    if (opts.credential) redacted = redacted.split(opts.credential).join('[redacted]');

    redacted = redacted
      // PEM key blocks — redact the whole block; the -----BEGIN/END----- markers are unambiguous, so
      // there is no false-positive risk and the base64 body (which the opaque rule cannot safely cover)
      // never survives.
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]')
      // Credentials in a URL's userinfo (scheme://user:pass@host) — a common HTTP-client error form.
      // The SCHEME class is bounded ({0,15}) because it has no leading anchor — unbounded it backtracks
      // O(n^2) on a long non-URL run. The userinfo is unbounded (any-length password) but ReDoS-safe: it
      // is reached only after the literal "://", and "[^/\s@]" excludes "/" so a repeated "scheme://…"
      // fast-fails instead of re-scanning (verified by probe).
      .replace(/([a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
      // Authorization header: redact the scheme + its first credential token (Bearer/Basic/…, incl.
      // short/letter-only values that dodge the prefix + opaque rules). Multi-param schemes (Digest) stop
      // at the first comma; their sensitive params (nonce/response) are caught by the opaque rule below.
      .replace(/\bAuthorization\s*:\s*(?:[A-Za-z][A-Za-z0-9-]*\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      // Unmistakable credential-PREFIX shapes — the src/release/scrub.ts credentialPatterns set: sk-*
      // (Anthropic/OpenAI), gh[po]_ + github_pat_ (GitHub), gsk_ (Groq), csk- (Cerebras),
      // lin_api_/lin_oauth_ (Linear), xox[baprs]- (Slack) — PLUS the AWS access-key-id shape A[KS]IA + 16
      // (AKIA long-term / ASIA STS): it is exactly 20 chars, so it DODGES the 24+ opaque backstop and needs
      // its own arm. Redacted by shape, so a BARE token (no key=value context, too short or dot-split for the
      // opaque rule) is still caught. Each arm is prefix + one bounded/unbounded class with no trailing
      // literal, so matching stays linear. (AWS SECRET keys are 40-char base64: a slashless one is caught by
      // the opaque rule; a '/'-containing one is an ACCEPTED residual — a '/'-inclusive rule would redact
      // long real filesystem paths, breaking F6's path passthrough — same class as the prefix-less opaque.)
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[po]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|csk-[A-Za-z0-9_-]+|lin_(?:api|oauth)_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|A[KS]IA[A-Z0-9]{16,})/g, '[redacted]')
      // key=value where the key NAME contains a sensitive word (ZAI_API_KEY=, aws_secret_access_key=,
      // "api_key": …). No \b so an embedded keyword matches; the {0,80}-bounded suffix stays ReDoS-safe
      // (an unbounded suffix is O(n^2) on a repeated-keyword run) and covers every realistic key name; any
      // prefix (ZAI_, aws_) stays outside the match and is preserved. Optional quotes for JSON bodies.
      .replace(/["']?((?:token|secret|password|api[-_]?key|x-api-key)[\w-]{0,80})["']?\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
      // Dotted token pairs (e.g. the GLM <32>.<16> key) — redact as a unit BEFORE the opaque catch-all,
      // which would otherwise split on the dot and leave the second half exposed. The lookbehind excludes
      // A-Za-z0-9_- but NOT '/', so a path/URL-nested key (src/<32>.<16>, //host-shaped) is still caught —
      // the {20,64}.{12,64} floor sits far above ordinary path segments (run.ts, foo.json), so the only
      // over-redaction this admits is a rare long dotted hostname label, which is the accepted direction.
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9]{20,64}\.[A-Za-z0-9]{12,64}(?![A-Za-z0-9])/g, '[redacted]');

    // Opaque tokens: 24+ chars containing a digit/underscore/dash — a HEURISTIC backstop for credential
    // shapes with no recognizable prefix (session tokens, JWT segments, Digest nonce/response). It cannot
    // tell a random token from a long filename, so it over-redacts long opaque names — the accepted
    // direction (under-redaction leaks; over-redaction only degrades debuggability). Real filesystem paths
    // survive via the '/' lookbehind/lookahead. Applied to the vendor-error string only (run.ts:337);
    // heddle-generated escape/destroyed notes carry checkout filenames and are persisted verbatim, never
    // routed through this rule (scrubbing those safely, without eating ordinary filenames, is HED-651).
    redacted = redacted.replace(/(?<![A-Za-z0-9_/-])(?=[A-Za-z0-9_-]*[0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_/-])/g, '[redacted]');

    return redacted;
  } catch {
    return text;
  }
}
