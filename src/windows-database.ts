import { dirname } from 'node:path';
import { assertSecureDir, ensureSecureDir } from './secure-fs.js';
import { assertWindowsPrivateFile, assertWindowsSqliteSidecar, createWindowsPrivateFile } from './secure-fs-windows.js';

/** SQLite inherits a private directory DACL; validate pre-existing files before opening the database. */
export function prepareWindowsDatabase(path: string): void {
  ensureSecureDir(dirname(path));
  try { createWindowsPrivateFile(path, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertWindowsDatabase(path);
}

/** Validate existing database storage without provisioning files, directories, or schema. */
export function assertWindowsDatabase(path: string): void {
  assertSecureDir(dirname(path));
  assertWindowsPrivateFile(path);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sibling = `${path}${suffix}`;
    try { assertWindowsSqliteSidecar(sibling); }
    catch (error) {
      // Sidecars are optional and may disappear after a checkpoint. Only absence is acceptable;
      // an unreadable or unsafe sidecar must not be hidden by an existsSync() pre-check.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
