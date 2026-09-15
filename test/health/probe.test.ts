import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultReadHookSettings } from '../../src/health/probe.js';

describe('defaultReadHookSettings', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('surfaces an unreadable settings file while treating ENOENT as absent', async () => {
    const path = join(tmpdir(), `heddle-unreadable-hook-settings-${process.pid}-${Date.now()}.json`);
    writeFileSync(path, '{}');
    chmodSync(path, 0);

    await expect(defaultReadHookSettings(path)).rejects.toThrow();
    await expect(defaultReadHookSettings(`${path}.missing`)).resolves.toBeUndefined();
  });
});
