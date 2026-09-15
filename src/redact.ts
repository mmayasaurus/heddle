/** Remove credential-shaped values from text that may be persisted or returned to callers. */
export function redactSecrets(text: string, opts: { credential?: string; shapesOnly?: boolean } = {}): string {
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
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[po]_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+)/g, '[redacted]')
      // key=value where the key NAME contains a sensitive word (ZAI_API_KEY=, aws_secret_access_key=,
      // "api_key": …). No \b so an embedded keyword matches; the {0,80}-bounded suffix stays ReDoS-safe
      // (an unbounded suffix is O(n^2) on a repeated-keyword run) and covers every realistic key name; any
      // prefix (ZAI_, aws_) stays outside the match and is preserved. Optional quotes for JSON bodies.
      .replace(/["']?((?:token|secret|password|api[-_]?key|x-api-key)[\w-]{0,80})["']?\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
      // Dotted token pairs (e.g. the GLM <32>.<16> key) — redact as a unit BEFORE the opaque catch-all,
      // which would otherwise split on the dot and leave the second half exposed.
      .replace(/(?<![A-Za-z0-9_/-])[A-Za-z0-9]{20,64}\.[A-Za-z0-9]{12,64}(?![A-Za-z0-9])/g, '[redacted]');

    // Opaque tokens: 24+ chars with a digit/underscore/dash. This is a HEURISTIC — it cannot tell a random
    // token from a long filename — so `shapesOnly` skips it. A caller redacting FILENAME-bearing text (the
    // ledger's escape/destroyed-work notes) uses shapesOnly to scrub the unmistakable credential SHAPES
    // above while preserving ordinary long filenames (real paths are already exempt via the '/' lookbehind).
    if (!opts.shapesOnly) {
      redacted = redacted.replace(/(?<![A-Za-z0-9_/-])(?=[A-Za-z0-9_-]*[0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_/-])/g, '[redacted]');
    }

    return redacted;
  } catch {
    return text;
  }
}
