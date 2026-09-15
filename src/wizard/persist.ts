// HED-564: shared persistence for wizard steps. Step modules import from here so the ~/.heddle/policy
// layout and the atomic-write mechanism live in ONE place — no step hardcodes a path or reimplements a
// half-written-file-safe write.
import { join } from 'node:path';

// Re-export the canonical atomic writer (temp-in-same-dir + rename, mode-preserving) so a step never
// hand-rolls its own. Single source: src/accounts.ts.
export { atomicWriteFile } from '../accounts.js';

/**
 * Absolute path of a wizard-written operator POLICY object: `<homeDir>/.heddle/policy/<id>.json`.
 * These are new operator-state objects (spread, model-economy, meters, rules, …) — distinct from the
 * repo-relative config-as-code `routing/lanes.yaml`, which the wizard never writes.
 */
export function policyPath(homeDir: string, id: string): string {
  return join(homeDir, '.heddle', 'policy', `${id}.json`);
}
