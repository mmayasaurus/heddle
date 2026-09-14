import { uninstallFleetBin, uninstallFleetHooks, uninstallFleetLaunchers } from './fleet.js';

export interface UninstallOptions {
  dryRun?: boolean;
}

export interface UninstallReport {
  removed: string[];
  preserved: string[];
  dryRun: boolean;
}

/**
 * Remove only fleet assets still provably identical to the shipped, manifest-verified canon;
 * preserve anything a user modified. This slice deliberately touches NOTHING outside
 * ~/.heddle/fleet — no registries, secrets, databases, or generated state. Destructive removal
 * of user-scoped data (a `--purge`-style flag) is intentionally out of scope: ~/.heddle
 * interleaves secrets, non-regenerable historical databases, user config, and regenerable state,
 * so its purge set is an operator (Maya) decision, tracked as a separate needs-Maya follow-up.
 */
export function uninstall(options: UninstallOptions = {}): UninstallReport {
  const dryRun = options.dryRun === true;
  const fleetReports = [
    uninstallFleetBin({ dryRun }),
    uninstallFleetHooks({ dryRun }),
    uninstallFleetLaunchers({ dryRun }),
  ];
  return {
    removed: fleetReports.flatMap((report) => report.removed),
    preserved: fleetReports.flatMap((report) => report.preserved),
    dryRun,
  };
}
