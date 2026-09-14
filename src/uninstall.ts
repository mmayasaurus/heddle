import { uninstallFleetBin, uninstallFleetHooks, uninstallFleetLaunchers, verifyFleetCanon } from './fleet.js';

export interface UninstallOptions {
  dryRun?: boolean;
}

export interface UninstallReport {
  removed: string[];
  preserved: string[];
  /** Anomalies that blocked removal across all asset sets (symlinked ancestor/target, or a
   * non-regular file at a canonical path). Surfaced, never deleted. */
  warnings: string[];
  dryRun: boolean;
}

/**
 * Remove only fleet assets still provably identical to the shipped, manifest-verified canon;
 * preserve anything a user modified. This slice deliberately touches NOTHING outside
 * ~/.heddle/fleet — no registries, secrets, databases, or generated state. Destructive removal
 * of user-scoped data (a `--purge`-style flag) is intentionally out of scope: ~/.heddle
 * interleaves secrets, non-regenerable historical databases, user config, and regenerable state,
 * so its purge set is an operator decision, tracked as a separate operator-gated follow-up.
 */
export function uninstall(options: UninstallOptions = {}): UninstallReport {
  const dryRun = options.dryRun === true;
  // Verify EVERY asset set's canon before removing anything: a manifest/canon failure must abort the
  // whole command, never leave one set removed and another still installed (atomic across sets). Each
  // per-set uninstaller re-verifies its own canon too; running all three checks up front is the
  // structural guarantee that removal is all-or-nothing across sets.
  verifyFleetCanon('bin');
  verifyFleetCanon('hook');
  verifyFleetCanon('launcher');
  const fleetReports = [
    uninstallFleetBin({ dryRun }),
    uninstallFleetHooks({ dryRun }),
    uninstallFleetLaunchers({ dryRun }),
  ];
  return {
    removed: fleetReports.flatMap((report) => report.removed),
    preserved: fleetReports.flatMap((report) => report.preserved),
    warnings: fleetReports.flatMap((report) => report.warnings),
    dryRun,
  };
}
