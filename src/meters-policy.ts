import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * HED-582: the shared usage-meter DISPLAY gate. The meters wizard step (HED-475) persists an operator
 * opt-in at `~/.heddle/policy/meters.json` (`{ accounts: { <id>: { meters: boolean } } }`); this reads it
 * and lets both usage-display producers (`readUsageRemaining`, top.ts `usageRows`) suppress the meters of
 * any account that opted OUT. It is deliberately FAIL-OPEN — the opposite contract from the wizard's
 * fail-loud reader — because this runs on the display hot path: a missing, unreadable, or corrupt policy
 * must show ALL meters, never blank the view or throw. (The wizard's own reader still surfaces corruption
 * on the next `heddle setup`.) Runtime layer: never import from wizard/.
 */
export function defaultMetersPolicyPath(): string {
  return process.env.HEDDLE_METERS_POLICY ?? join(homedir(), '.heddle', 'policy', 'meters.json');
}

/** A non-null, non-array object — the only shape the policy object and its per-account entries may take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Best-effort set of account ids (lower-cased, matching the case-insensitive `--account` filter) that
 * opted OUT of meter display (`meters === false`). FAIL-OPEN: any read / parse / shape problem yields an
 * empty set (gate nothing) — an absent, unreadable, or non-JSON file; an `accounts` map that is missing,
 * non-object, or ARRAY-shaped (its numeric indexes must never become account ids); or a single malformed
 * entry. The malformed-entry rule mirrors the wizard writer's validator (meters-step.ts `readPriorPolicy`,
 * which rejects exactly these), so the reader never applies a partial gate from a policy the writer would
 * reject. Never throws.
 */
export function readOptedOutAccounts(policyPath?: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath ?? defaultMetersPolicyPath(), 'utf8'));
  } catch {
    return new Set(); // absent / unreadable (EISDIR, EACCES, …) / invalid JSON → gate nothing
  }
  if (!isPlainObject(parsed)) return new Set();
  const { accounts } = parsed;
  if (!isPlainObject(accounts)) return new Set(); // missing, non-object, or array-shaped → gate nothing
  const optedOut = new Set<string>();
  for (const [id, entry] of Object.entries(accounts)) {
    if (!isPlainObject(entry)) return new Set(); // malformed entry → whole policy untrusted → fail open
    const { meters } = entry;
    if (meters !== undefined && typeof meters !== 'boolean') return new Set(); // malformed → fail open
    if (meters === false) optedOut.add(id.toLowerCase());
  }
  return optedOut;
}

/**
 * Drop per-account rows whose account opted out; provider-level rows (`account === null`) are NEVER gated
 * (they have no account id to key on and are the binding cross-account view). Account ids are compared
 * case-insensitively (the opted-out set is already lower-cased). Pure; generic so it does not couple to
 * the row interface. Returns the input array unchanged when nothing opted out.
 */
export function filterByMetersPolicy<T extends { account: string | null }>(
  rows: T[],
  optedOut: ReadonlySet<string>,
): T[] {
  if (optedOut.size === 0) return rows;
  return rows.filter((row) => row.account === null || !optedOut.has(row.account.toLowerCase()));
}
