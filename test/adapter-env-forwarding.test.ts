import { describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary so we assert the ARGS each adapter forwards, without spawning.
vi.mock('../src/adapters/subprocess.js', () => ({
  run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1, timedOut: false }),
}));

import { run } from '../src/adapters/subprocess.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CursorAdapter } from '../src/adapters/cursor.js';

const mockedRun = vi.mocked(run);

// run(bin, args, cwd, timeoutMs, envOverrides?, envUnset?) — envUnset is positional arg index 5.
describe('subprocess adapters forward envUnset to run (HED-268 account-selector unset)', () => {
  it('codex forwards envUnset so a default-account CODEX_HOME unset actually reaches the worker', async () => {
    mockedRun.mockClear();
    await new CodexAdapter().dispatch('x', { model: 'gpt-5.6-terra', cwd: '/tmp', env: { CODEX_HOME: '/h' }, envUnset: ['CODEX_HOME'] });
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][4]).toEqual({ CODEX_HOME: '/h' }); // env overrides
    expect(mockedRun.mock.calls[0][5]).toEqual(['CODEX_HOME']);        // envUnset — silently dropped before the fix
  });

  it('cursor forwards envUnset for the machine-login CURSOR_API_KEY unset', async () => {
    mockedRun.mockClear();
    // a supplemental (non-direct-subscription) model so the billing-safety floor does not short-circuit before run.
    await new CursorAdapter().dispatch('x', { model: 'kimi-k3', cwd: '/tmp', env: {}, envUnset: ['CURSOR_API_KEY'] });
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][5]).toEqual(['CURSOR_API_KEY']);
  });
});
