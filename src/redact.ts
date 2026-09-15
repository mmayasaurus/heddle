// The credential-PREFIX arms — a SUPERSET of src/release/scrub.ts credentialPatterns: the shared sk-,
// github_pat_, gsk_, csk-, lin_api_/lin_oauth_; gh[po]_ (scrub.ts has ghp_ only — this also catches
// gho_); PLUS xox[baprs]- (Slack) and the AWS access-key-id shape A[KS]IA + 16, neither of which is in
// scrub.ts. SINGLE SOURCE OF TRUTH for both redaction modes, so a prefix added here is covered in
// full mode AND shapes-only and the two can never drift apart. sk- alone is a common English substring
// (ta[sk]-, di[sk]-, ri[sk]-), so it carries a LEFT BOUNDARY in both modes (\b in full mode,
// (?<![A-Za-z]) in the shapes-only pass); every DISTINCTIVE arm appears in no ordinary filename, so the
// shapes-only pass matches it with NO left boundary to catch a credential DECORATED into a filename
// (backup_ghp_…) that full mode's opaque backstop would otherwise have swept up.
const SK_PREFIX_ARM = 'sk-[A-Za-z0-9_-]+';
const DISTINCTIVE_PREFIX_ARMS =
  'gh[po]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|csk-[A-Za-z0-9_-]+|lin_(?:api|oauth)_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|A[KS]IA[A-Z0-9]{16,}';
// Full mode: the \b-anchored alternation (sk- + distinctive), assembled from the shared arms — its source
// is character-identical to the prior inline literal (proven by the full-mode fixture suite + the
// byte-identical snapshot test). Hoisted to module scope: String.replace resets a global regex's
// lastIndex to 0 before matching, so reuse across calls is safe.
const CREDENTIAL_PREFIX_RULE = new RegExp(`\\b(?:${SK_PREFIX_ARM}|${DISTINCTIVE_PREFIX_ARMS})`, 'g');
// Shapes-only: the DISTINCTIVE arms only, with no left boundary (embedded-in-filename credential).
const EMBEDDED_DISTINCTIVE_PREFIX_RULE = new RegExp(DISTINCTIVE_PREFIX_ARMS, 'g');
// Shapes-only sk-: the shared SK_PREFIX_ARM guarded by a LEFT-LETTER boundary only (single source with
// full mode's sk- arm, so the two can't drift; _/digit/boundary decorations are caught, English
// ta[sk]-/di[sk]- survive). Its source is character-identical to the prior inline shapes-only literal.
const EMBEDDED_SK_RULE = new RegExp('(?<![A-Za-z])' + SK_PREFIX_ARM, 'g');

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
      // Unmistakable credential-PREFIX shapes — a SUPERSET of src/release/scrub.ts credentialPatterns:
      // sk-* (Anthropic/OpenAI), gh[po]_ + github_pat_ (GitHub; scrub.ts has ghp_ only, this also
      // catches gho_), gsk_ (Groq), csk- (Cerebras), lin_api_/lin_oauth_ (Linear), xox[baprs]- (Slack,
      // not in scrub.ts) — PLUS the AWS access-key-id shape A[KS]IA + 16 (also not in scrub.ts;
      // AKIA long-term / ASIA STS): it is exactly 20 chars, so it DODGES the 24+ opaque backstop and needs
      // its own arm. Redacted by shape, so a BARE token (no key=value context, too short or dot-split for the
      // opaque rule) is still caught. Each arm is prefix + one bounded/unbounded class with no trailing
      // literal, so matching stays linear. (AWS SECRET keys are 40-char base64: a slashless one is caught by
      // the opaque rule; a '/'-containing one is an ACCEPTED residual — a '/'-inclusive rule would redact
      // long real filesystem paths, breaking F6's path passthrough — same class as the prefix-less opaque.)
      // The alternation is the shared CREDENTIAL_PREFIX_RULE const (single source with the shapes-only pass).
      .replace(CREDENTIAL_PREFIX_RULE, '[redacted]')
      // key=value where the key NAME contains a sensitive word (ZAI_API_KEY=, aws_secret_access_key=,
      // "api_key": …). No \b so an embedded keyword matches; the {0,80}-bounded suffix stays ReDoS-safe
      // (an unbounded suffix is O(n^2) on a repeated-keyword run) and covers every realistic key name; any
      // prefix (ZAI_, aws_) stays outside the match and is preserved. Optional quotes for JSON bodies.
      .replace(/["']?((?:token|secret|password|api[-_]?key|x-api-key)[\w-]{0,80})["']?\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
      // Dotted token pairs (e.g. the GLM <32>.<16> key) — redact as a unit BEFORE the opaque catch-all,
      // which would otherwise split on the dot and leave the second half exposed. The lookbehind excludes
      // A-Za-z0-9_- but NOT '/', so a path/URL-nested key (src/<32>.<16>, //host-shaped) is still caught —
      // the {20,}.{12,} floor sits far above ordinary path segments (run.ts, foo.json), so the only
      // over-redaction this admits is a rare long dotted hostname label, which is the accepted direction.
      // (HED-663: ceilings removed so an over-long run glued to the key can't outrun them and leak; same behavior in both modes now.)
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9]{20,}\.[A-Za-z0-9]{12,}(?![A-Za-z0-9])/g, '[redacted]');

    // Opaque tokens: 24+ chars containing a digit/underscore/dash — a HEURISTIC backstop for credential
    // shapes with no recognizable prefix (session tokens, JWT segments, Digest nonce/response). It cannot
    // tell a random token from a long filename, so it over-redacts long opaque names — the accepted
    // direction (under-redaction leaks; over-redaction only degrades debuggability). Real filesystem paths
    // survive via the '/' lookbehind/lookahead. This backstop runs in FULL mode only (the vendor-error
    // string).
    if (!opts.shapesOnly) {
      redacted = redacted.replace(/(?<![A-Za-z0-9_/-])(?=[A-Za-z0-9_-]*[0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_/-])/g, '[redacted]');
    } else {
      // Shapes-only (heddle-generated escape/destroyed notes, HED-651): the opaque backstop is OFF so an
      // ordinary long filename survives. But without it a recognized credential DECORATED into a filename
      // (backup_ghp_…, notes_lin_api_…, backup_<32>.<16>) slips past the \b / [A-Za-z0-9_-] lookbehind
      // anchors on the shared shape rules above — those anchors were relying on the backstop to sweep up
      // the embedded case. Re-run the shapes that can match EMBEDDED with no false positives:
      //   • DISTINCTIVE prefixes (every arm but sk-): no ordinary filename contains them → match with no
      //     left boundary (EMBEDDED_DISTINCTIVE_PREFIX_RULE, built from the SAME arms as full mode's rule,
      //     so the two cannot drift);
      //   • sk-: a common English substring (ta[sk]-, di[sk]-, ri[sk]-), so guard only against a preceding
      //     LETTER (EMBEDDED_SK_RULE = (?<![A-Za-z]) + the shared SK_PREFIX_ARM) — _/digit/boundary-
      //     decorated (backup_sk-, v2sk-) are caught, the English words survive;
      //   • the GLM-dotted pair, lookbehind relaxed to (?<![A-Za-z0-9]) so a leading _/- is allowed
      //     (the shared rule's lookbehind excludes _ and misses backup_<32>.<16>); the shared rule is now
      //     also unbounded (HED-663), so this arm's DISTINCT job is only that relaxed lookbehind. The pinned
      //     start keeps it linear. Over-redaction direction: a rare ordinary <20+>.<12+> alnum name.
      // Residuals (accepted, same class as the prefix-less opaque token this mode already preserves):
      //   (1) a recognized prefix decorated with a LETTER (xsk-…) is indistinguishable from an ordinary
      //       word;
      //   (2) a credential family in NEITHER the enumerated arms NOR the GLM shape (a novel vendor
      //       prefix) — shapes-only recognizes only the enumerated forms, so it leaks here, though full
      //       mode's opaque backstop still catches it on the vendor-error path.
      redacted = redacted
        .replace(EMBEDDED_DISTINCTIVE_PREFIX_RULE, '[redacted]')
        .replace(EMBEDDED_SK_RULE, '[redacted]')
        .replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{20,}\.[A-Za-z0-9]{12,}(?![A-Za-z0-9])/g, '[redacted]');
    }

    return redacted;
  } catch {
    return text;
  }
}
