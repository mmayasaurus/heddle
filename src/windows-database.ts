import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureSecureDir } from './secure-fs.js';
import { assertWindowsPrivateFile, createWindowsPrivateFile } from './secure-fs-windows.js';

/** SQLite inherits a private directory DACL; validate pre-existing files before opening the database. */
export function prepareWindowsDatabase(path: string): void {
  ensureSecureDir(dirname(path));
  try { createWindowsPrivateFile(path, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertWindowsPrivateFile(path);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sibling = `${path}${suffix}`;
    if (existsSync(sibling)) {
      try { assertWindowsPrivateFile(sibling); }
      catch (error) {
        // Another SQLite connection may finish a checkpoint between the existence check and open.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
