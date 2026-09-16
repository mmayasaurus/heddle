import { constants, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientFileSource } from '../src/client-config.js';
import { useTempResources } from './helpers.js';

vi.mock('node:fs', async (importOriginal) => {
  try {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, openSync: vi.fn(fs.openSync) };
  } catch (error) { throw new Error(`filesystem test setup failed: ${String(error)}`); }
});
afterEach(() => vi.mocked(openSync).mockReset());

describe('regression PR#258 — reject a replaced worktree owner before reading it', () => {
  const { tempDir } = useTempResources('heddle-marker-race-');
  it('rejects an actual different file opened after the metadata check, even without POSIX flags', async () => {
    try {
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const root = realpathSync(tempDir()), marker = join(root, '.fleet-agent');
      writeFileSync(marker, 'original-seat');
      vi.mocked(openSync).mockImplementationOnce((path) => {
        renameSync(marker, marker + '.preserved');
        writeFileSync(marker, 'replacement-seat');
        return fs.openSync(path, constants.O_RDONLY);
      });
      expect(() => clientFileSource(marker, 256)).toThrow('changed while opening');
      expect(readFileSync(marker, 'utf8')).toBe('replacement-seat');
      expect(readFileSync(marker + '.preserved', 'utf8')).toBe('original-seat');
    } catch (error) { throw new Error(`marker replacement regression failed: ${String(error)}`); }
  });
});
