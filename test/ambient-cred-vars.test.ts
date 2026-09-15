import { describe, expect, it } from 'vitest';
import { runCli, withTempHome } from './helpers/cli.js';
import { CLAUDE_AMBIENT_CRED_VARS } from '../src/wizard/ambient-cred-vars.js';

describe('ambient-cred-vars CLI', () => {
  it('emits the canonical names as text', async () => {
    const { code, stdout } = await runCli(['ambient-cred-vars'], { home: withTempHome() });
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toEqual([...CLAUDE_AMBIENT_CRED_VARS]);
  });

  it('emits the canonical names as JSON', async () => {
    const { code, stdout } = await runCli(['ambient-cred-vars', '--json'], { home: withTempHome() });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([...CLAUDE_AMBIENT_CRED_VARS]);
  });

  it('exports non-empty, conventional environment-variable names', () => {
    expect(CLAUDE_AMBIENT_CRED_VARS).not.toHaveLength(0);
    expect(CLAUDE_AMBIENT_CRED_VARS.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))).toBe(true);
  });
});
