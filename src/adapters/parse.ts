/**
 * Shared stdout parsing for adapters whose CLI prints one `{type:"result"}` JSON object as the
 * last JSON line (claude `--output-format json`, cursor-agent `--output-format json`). Progress
 * noise may precede it, so scan bottom-up and skip anything that is not the result object.
 */
export function lastResultJson(stdout: string): any | undefined {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.type === 'result') return parsed;
    } catch { /* keep scanning */ }
  }
  return undefined;
}
