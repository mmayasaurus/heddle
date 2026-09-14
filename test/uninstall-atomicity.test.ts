import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the fleet layer so we can force ONE asset set's canon verification to fail and assert that NO
// asset set was removed. This is the partial-removal guarantee: uninstall() verifies every canon
// before it removes anything, so a later manifest/canon failure removes nothing at all.
vi.mock('../src/fleet.js', () => {
  const emptyReport = () => ({ targetDir: '', dryRun: false, removed: [], preserved: [], warnings: [] });
  return {
    verifyFleetCanon: vi.fn(),
    uninstallFleetBin: vi.fn(emptyReport),
    uninstallFleetHooks: vi.fn(emptyReport),
    uninstallFleetLaunchers: vi.fn(emptyReport),
  };
});

import { uninstallFleetBin, uninstallFleetHooks, uninstallFleetLaunchers, verifyFleetCanon } from '../src/fleet.js';
import { uninstall } from '../src/uninstall.js';

describe('uninstall atomicity across asset sets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history but NOT implementations — drop any throwing impl a prior test
    // set on verifyFleetCanon so it defaults back to a no-op (passes). The uninstaller mocks keep the
    // empty-report implementation from the factory.
    vi.mocked(verifyFleetCanon).mockReset();
  });

  it('verifies every canon before removing any, so a later failure removes nothing', () => {
    // 'bin' is verified first and passes; 'hook' (verified second) throws. If removal were interleaved
    // with verification, bin would already be gone — this asserts it is not.
    vi.mocked(verifyFleetCanon).mockImplementation((kind) => {
      if (kind === 'hook') throw new Error('fleet manifest mismatch for hooks/agent-identity.py');
    });

    expect(() => uninstall()).toThrow(/manifest mismatch/);

    expect(uninstallFleetBin).not.toHaveBeenCalled();
    expect(uninstallFleetHooks).not.toHaveBeenCalled();
    expect(uninstallFleetLaunchers).not.toHaveBeenCalled();
  });

  it('removes all sets when every canon verifies', () => {
    const report = uninstall();

    expect(verifyFleetCanon).toHaveBeenCalledTimes(3);
    expect(uninstallFleetBin).toHaveBeenCalledTimes(1);
    expect(uninstallFleetHooks).toHaveBeenCalledTimes(1);
    expect(uninstallFleetLaunchers).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ removed: [], preserved: [], warnings: [], dryRun: false });
  });
});
