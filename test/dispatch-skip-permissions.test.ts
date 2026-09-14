import { describe, expect, it } from 'vitest';
import { AgyAdapter } from '../src/adapters/agy.js';
import { dispatch } from '../src/dispatch.js';
import type { WorkerAdapter } from '../src/types.js';
import { IDENTITIES, useTempResources } from './helpers.js';

describe('dispatch permission-prompt opt-out', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-skip-permissions-test-');

  function capturingAgy(argv: string[][]): WorkerAdapter {
    return {
      name: 'capturing-agy',
      provider: 'gemini',
      dispatch: async (prompt, opts) => {
        argv.push(new AgyAdapter().buildArgs(prompt, opts));
        return { ok: true, output: '', exitCode: 0 };
      },
    };
  }

  it('keeps agy permission prompts when the public dispatch request opts out of skipping them', async () => {
    const argv: string[][] = [];
    await dispatch({
      taskClass: 'gemini-analysis', prompt: 'analyze', cwd: tempDir(), identity: IDENTITIES.unbound,
      skipPermissions: false,
    }, tempLedger(), (provider) => {
      expect(provider).toBe('gemini');
      return capturingAgy(argv);
    });

    expect(argv).toHaveLength(1);
    expect(argv[0]).not.toContain('--dangerously-skip-permissions');
  });

  it('keeps agy permission skipping as the public dispatch default', async () => {
    const argv: string[][] = [];
    await dispatch({
      taskClass: 'gemini-analysis', prompt: 'analyze', cwd: tempDir(), identity: IDENTITIES.unbound,
    }, tempLedger(), (provider) => {
      expect(provider).toBe('gemini');
      return capturingAgy(argv);
    });

    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain('--dangerously-skip-permissions');
  });
});
