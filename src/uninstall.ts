import { existsSync, unlinkSync } from 'node:fs';
import { DEFAULT_PROJECTS_PATH } from './projects.js';
import { DEFAULT_ACCOUNTS_PATH } from './capaware.js';
import { uninstallFleetBin, uninstallFleetHooks, uninstallFleetLaunchers } from './fleet.js';

export interface UninstallOptions {
  dryRun?: boolean;
  purge?: boolean;
  projectsPath?: string;
  accountsPath?: string;
}

export interface UninstallReport {
  removed: string[];
  preserved: string[];
  purged: string[];
  dryRun: boolean;
  purge: boolean;
}

/** Remove only fleet assets still provably identical to the shipped, manifest-verified canon. */
export function uninstall(options: UninstallOptions = {}): UninstallReport {
  const dryRun = options.dryRun === true;
  const fleetReports = [
    uninstallFleetBin({ dryRun }),
    uninstallFleetHooks({ dryRun }),
    uninstallFleetLaunchers({ dryRun }),
  ];
  const purged: string[] = [];
  if (options.purge) {
    for (const path of [
      options.projectsPath ?? (process.env.HEDDLE_PROJECTS?.trim() || DEFAULT_PROJECTS_PATH),
      options.accountsPath ?? (process.env.HEDDLE_ACCOUNTS?.trim() || DEFAULT_ACCOUNTS_PATH),
    ]) {
      if (!existsSync(path)) continue;
      if (!dryRun) unlinkSync(path);
      purged.push(path);
    }
  }
  return {
    removed: fleetReports.flatMap((report) => report.removed),
    preserved: fleetReports.flatMap((report) => report.preserved),
    purged,
    dryRun,
    purge: options.purge === true,
  };
}
