/**
 * Neutralize C0 (`\x00`–`\x1f`), DEL (`\x7f`) and C1 (`\x80`–`\x9f`) control characters into a visible
 * `\xNN` escape. A value that may originate outside heddle's control — e.g. a credential path derived
 * from `$HOME` — must not be able to inject newlines, carriage returns, or ANSI/terminal escape
 * sequences when it reaches a terminal (stderr), a log line, or the durable ledger (HED-638 hardening;
 * qodo #239 log-injection HIGH).
 *
 * Idempotent: the output is printable ASCII (a backslash plus lowercase hex), none of which fall in the
 * escaped ranges, so escaping an already-escaped string is a no-op. Iterates by character rather than a
 * control-character regex to stay clear of `no-control-regex` and keep the intent obvious.
 */
export function escapeControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : ch;
  }
  return out;
}
