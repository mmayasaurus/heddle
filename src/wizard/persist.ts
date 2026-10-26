// HED-564: shared persistence for wizard steps. Step modules import from here so the ~/.heddle/policy
// layout and the atomic-write mechanism live in ONE place — no step hardcodes a path or reimplements a
// half-written-file-safe write.
import { join } from 'node:path';

// Re-export the canonical atomic writer (temp-in-same-dir + rename, mode-preserving) so a step never
// hand-rolls its own. Single source: src/accounts.ts.
//
// TRUST DOMAIN (HED-650): this writer is for the operator's OWN policy objects under `~/.heddle` — a
// same-uid trust domain, where its `mkdirSync(recursive)` following a symlinked ancestor is harmless. A step
// that scaffolds PUBLIC files into a user-selected PROJECT repo must NOT use it: git carries symlinks as
// content, so a cloned repo can ship a symlinked `.github` that would relocate the write outside the tree.
// Those writes go through `createFileWithinRoot` (src/secure-fs.ts), which guards the directory chain below
// the repo root. The pr-automation and cd-automation steps route there; the policy steps here stay on
// atomicWriteFile.
export { atomicWriteFile } from '../accounts.js';

/**
 * Absolute path of a wizard-written operator POLICY object: `<homeDir>/.heddle/policy/<id>.json`.
 * These are new operator-state objects (spread, model-economy, meters, rules, …) — distinct from the
 * repo-relative config-as-code `routing/lanes.yaml`, which the wizard never writes.
 */
export function policyPath(homeDir: string, id: string): string {
  return join(homeDir, '.heddle', 'policy', `${id}.json`);
}
