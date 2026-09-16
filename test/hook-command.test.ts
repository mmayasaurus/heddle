import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, isHeddleHookCommand } from '../src/hook-command.js';
import { defaultExecHook } from '../src/health/probe.js';
import { useTempResources } from './helpers.js';

describe('native hook shell boundary', () => {
  const { tempDir } = useTempResources('heddle-hook-command-');
  const args = ['a b', "it's linen", '%PATH%', '$HOME', 'a&b|c', 'linen 🧶', '--heddle-fleet-hook'];

  it('recognizes owned commands on both platforms while preserving foreign commands', () => {
    const prefix = ['node', 'hook.js', 'codex', 'Stop', "a b/it's linen"];
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const agent of ['', 'codex-before', 'codex-after']) {
        expect(isHeddleHookCommand(hookCommand([...prefix, agent, '--heddle-fleet-hook'], platform), prefix)).toBe(true);
      }
      expect(isHeddleHookCommand(hookCommand(['node', 'foreign.js', 'codex-before', '--heddle-fleet-hook'], platform), prefix)).toBe(false);
      expect(isHeddleHookCommand(hookCommand([...prefix, "bad'; command", '--heddle-fleet-hook'], platform), prefix)).toBe(false);
    }
    expect(isHeddleHookCommand('user-hook --heddle-fleet-hook', prefix)).toBe(false);
    expect(isHeddleHookCommand('powershell.exe -EncodedCommand not-base64', prefix)).toBe(false);
  });

  it('upgrades owned Windows hooks that predate explicit raw stdin handling', () => {
    const prefix = ['node', 'hook.js', 'codex', 'Stop', 'project'];
    const current = hookCommand([...prefix, 'codex-before', '--heddle-fleet-hook'], 'win32');
    expect(current).toContain(' -InputFormat None ');
    expect(isHeddleHookCommand(current, prefix)).toBe(true);
    expect(isHeddleHookCommand(current.replace(' -InputFormat None', ''), prefix)).toBe(true);
    const foreign = hookCommand(['node', 'foreign.js', 'codex-before', '--heddle-fleet-hook'], 'win32');
    expect(isHeddleHookCommand(foreign.replace(' -InputFormat None', ''), prefix)).toBe(false);
  });

  it('executes the generated command with literal arguments, stdin, and exit status', async () => {
    const dir = tempDir();
    const script = join(dir, 'hook child.mjs');
    writeFileSync(script, 'import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,"utf8")}));');
    const command = hookCommand([process.execPath, script, ...args]);
    const shells = process.platform === 'win32'
      ? [{ bin: 'cmd.exe', args: ['/d', '/s', '/c', command] }, { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }]
      : [{ bin: '/bin/sh', args: ['-c', command] }];
    for (const shell of shells) {
      const output = execFileSync(shell.bin, shell.args, { input: '{"hook":"input"}', encoding: 'utf8', timeout: 15_000 });
      expect(JSON.parse(output.trim())).toEqual({ args, input: '{"hook":"input"}' });
    }
    const options = { cwd: dir, env: process.env, stdin: '{"hook":"probe input"}', timeoutMs: 15_000 };
    // Exercise the health checker boundary too: Windows shell hooks must never be sent to /bin/sh.
    // The direct argv form must continue bypassing shell interpretation of literal metacharacters.
    for (const probe of [
      await defaultExecHook(command, undefined, options),
      await defaultExecHook(process.execPath, [script, ...args], options),
    ]) {
      expect(probe).toMatchObject({ exitCode: 0, timedOut: false, stderr: '' });
      expect(JSON.parse(probe.stdout.trim())).toEqual({ args, input: options.stdin });
    }
    writeFileSync(script, 'process.exit(7);');
    for (const shell of shells) {
      try { execFileSync(shell.bin, shell.args, { stdio: 'pipe', timeout: 15_000 }); throw new Error('expected nonzero exit'); }
      catch (error) { expect((error as { status?: number }).status).toBe(7); }
    }
    expect(await defaultExecHook(command, undefined, options)).toMatchObject({ exitCode: 7, timedOut: false });
  }, 60_000);

  it.runIf(process.platform === 'win32')('reports a missing executable as failure instead of a successful hook', () => {
    const command = hookCommand([join(tempDir(), 'missing.exe'), '--heddle-fleet-hook']);
    try { execFileSync('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'pipe', timeout: 15_000 }); throw new Error('expected failure'); }
    catch (error) { expect((error as { status?: number }).status).toBe(1); }
  });

  it.runIf(process.platform === 'win32')('health-probes ordinary hooks with quoted executable and script paths', async () => {
    const dir = tempDir();
    const runtime = join(dir, 'node runtime');
    mkdirSync(runtime);
    const executable = join(runtime, 'node.exe');
    copyFileSync(process.execPath, executable); // guarantee a spaced executable path on every CI image
    const script = join(dir, 'ordinary hook.mjs');
    writeFileSync(script, 'import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,"utf8")}));');
    const command = `"${executable}" "${script}" "a b" "a&b"`;
    const options = { cwd: dir, env: process.env, stdin: '{"hook":"quoted-path input"}', timeoutMs: 15_000 };
    const result = await defaultExecHook(command, undefined, options);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stderr: '' });
    expect(JSON.parse(result.stdout.trim())).toEqual({ args: ['a b', 'a&b'], input: options.stdin });
    writeFileSync(script, 'process.exit(7);');
    expect(await defaultExecHook(command, undefined, options)).toMatchObject({ exitCode: 7, timedOut: false });
  }, 60_000);
});
