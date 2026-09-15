/** Remove credential-shaped values from text that may be persisted or returned to callers. */
export function redactSecrets(text: string, opts: { credential?: string } = {}): string {
  try {
    let redacted = text;
    if (opts.credential) redacted = redacted.split(opts.credential).join('[redacted]');

    redacted = redacted
      .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[po]_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+)/g, '[redacted]')
      // No \b before the keyword: env-var names embed it after word chars (ZAI_API_KEY=, ACCESS_TOKEN=,
      // ANTHROPIC_AUTH_TOKEN=), which is the most likely stderr leak form (env dumps, `set -x`, config
      // print-on-error). The prefix stays outside the match, so ZAI_API_KEY=<v> -> ZAI_API_KEY=[redacted].
      .replace(/(token|secret|password|api[-_]?key|x-api-key)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
      // Require a digit, underscore, or dash so ordinary long words and identifier-like prose pass through.
      .replace(/(?<![A-Za-z0-9_/-])(?=[A-Za-z0-9_-]*[0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_/-])/g, '[redacted]');

    return redacted;
  } catch {
    return text;
  }
}
