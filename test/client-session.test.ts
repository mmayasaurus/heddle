import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planClientSession } from '../src/client-session.js';
import { useTempResources } from './helpers.js';
import { childEnv, ensureBuilt, PROJECT_ROOT, runCli } from './helpers/cli.js';

describe('native session launch', () => {
  const { tempDir } = useTempResources('heddle-native-session-');
  it.runIf(process.platform === 'win32')('reports an interrupted Windows launch with exit status 130', async () => {
    await ensureBuilt();
    const dir = realpathSync.native(tempDir());
    const script = join(dir, 'worker.mjs');
    const pidFile = join(dir, 'worker.pid');
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
    const module = pathToFileURL(join(PROJECT_ROOT, 'dist', 'client-session.js')).href;
    const code = `import {runClientSession} from ${JSON.stringify(module)};
      const result=runClientSession(${JSON.stringify({ client: 'opencode', dir, agent: 'codex-test', bin: process.execPath, args: [script] })});
      setTimeout(()=>process.emit('SIGINT'),1000);process.exitCode=await result;`;
    const { env } = childEnv();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 15_000 });
    try {
      expect(child.status, child.stderr).toBe(130);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped by the launcher. */ }
        }
      }
    }
  });
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
