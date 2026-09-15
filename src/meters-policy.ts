import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * HED-582: the shared usage-meter DISPLAY gate. The meters wizard step (HED-475) persists an operator
 * opt-in at `~/.heddle/policy/meters.json` (`{ accounts: { <id>: { meters: boolean } } }`); this reads it
 * and lets both usage-display producers (`readUsageRemaining`, top.ts `usageRows`) drop the meters of any
 * account that opted OUT. It is deliberately FAIL-OPEN — the opposite contract from the wizard's fail-loud
 * reader — because this runs on the display hot path: a missing, unreadable, or corrupt policy must show
 * ALL meters, never blank the view or throw. (The wizard's own reader still surfaces corruption on the next
 * `heddle setup`.) Runtime layer: never import from wizard/.
 */
export function defaultMetersPolicyPath(): string {
  return process.env.HEDDLE_METERS_POLICY ?? join(homedir(), '.heddle', 'policy', 'meters.json');
}

/**
 * Best-effort set of account ids that opted OUT of meter display (`meters === false`). Any read/parse/shape
 * problem yields an empty set (= gate nothing). Never throws.
 */
export function readOptedOutAccounts(policyPath?: string): Set<string> {
  const out = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath ?? defaultMetersPolicyPath(), 'utf8'));
  } catch {
    return out; // absent / unreadable (EISDIR, EACCES, …) / invalid JSON → gate nothing
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const accounts = (parsed as { accounts?: unknown }).accounts;
  if (!accounts || typeof accounts !== 'object') return out;
  for (const [id, entry] of Object.entries(accounts as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && (entry as { meters?: unknown }).meters === false) out.add(id);
  }
  return out;
}

/**
 * Drop per-account rows whose account opted out; provider-level rows (`account === null`) are NEVER gated
 * (they have no account id to key on and are the binding cross-account view). Pure; generic so it does not
 * couple to the row interface. Returns the input array unchanged when nothing opted out.
 */
export function filterByMetersPolicy<T extends { account: string | null }>(
  rows: T[],
  optedOut: ReadonlySet<string>,
): T[] {
  if (optedOut.size === 0) return rows;
  return rows.filter((row) => row.account === null || !optedOut.has(row.account));
}
