import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planClientSession } from '../src/client-session.js';
import { useTempResources } from './helpers.js';
import { runCli } from './helpers/cli.js';

describe('native session launch', () => {
  const { tempDir } = useTempResources('heddle-native-session-');
  it('uses each native resume contract and preserves explicit native arguments', () => {
    const dir = realpathSync.native(tempDir());
    for (const client of ['codex', 'cursor', 'gemini', 'opencode'] as const) {
      const p = planClientSession({ client, dir, agent: 'codex-test', resume: 'saved-id', model: 'test-model', args: ['hello'] }, {});
      expect(p.args).toContain('saved-id');
      expect(p.args.slice(-3)).toEqual(['--model', 'test-model', 'hello']);
      expect(p.dir).toBe(dir);
    }
    expect(planClientSession({ client: 'opencode', dir, agent: 'codex-test', resume: 'latest' }, {}).args).toEqual(['--continue']);
  });
  it('refuses worker escalation, missing identities, and a different worktree owner', () => {
    const dir = realpathSync.native(tempDir());
    expect(() => planClientSession({ client: 'codex', dir }, {})).toThrow('assigned fleet identity');
    expect(() => planClientSession({ client: 'codex', dir, agent: 'codex-test' }, { HEDDLE_WORKER: '1' })).toThrow('worker cannot');
    writeFileSync(join(dir, '.fleet-agent'), 'codex-other');
    expect(() => planClientSession({ client: 'codex', dir, agent: 'codex-test' }, {})).toThrow('worktree belongs');
  });
  it('launches an actual child with the chosen cwd/identity and propagates its exit', async () => {
    const dir = realpathSync.native(tempDir());
    const script = join(dir, 'child.mjs');
    writeFileSync(script, 'console.log(JSON.stringify({cwd:process.cwd(),agent:process.env.HEDDLE_AGENT,client:process.env.HEDDLE_CLIENT,push:process.env.HEDDLE_COMMS_PUSH,nativeAuthPreserved:process.env.CURSOR_API_KEY==="test-only-auth",nativeConfig:process.env.OPENCODE_CONFIG,operatorTokenPresent:process.env.HEDDLE_COMMS_OPERATOR_TOKEN!==undefined}));process.exitCode=7;');
    const result = await runCli(['launch', 'opencode', '--dir', dir, '--agent', 'codex-test', '--bin', process.execPath, '--', script],
      { env: { CURSOR_API_KEY: 'test-only-auth', OPENCODE_CONFIG: 'native-config.json', HEDDLE_COMMS_OPERATOR_TOKEN: 'test-only-operator-token' } });
    expect(result.code, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: dir, agent: 'codex-test', client: 'opencode', push: '0', nativeAuthPreserved: true, nativeConfig: 'native-config.json', operatorTokenPresent: false });
  });
});
