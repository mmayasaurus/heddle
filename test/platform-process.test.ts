import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { killGroupOrChild, run, spawnProbe } from '../src/adapters/subprocess.js';
import { useTempResources } from './helpers.js';

describe('native platform process execution', () => {
  const { tempDir } = useTempResources('heddle-platform-');

  it('still kills the direct child when the Windows taskkill utility fails', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = vi.fn();
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.stubEnv('SystemRoot', join(tempDir(), 'missing-windows'));
      killGroupOrChild({ pid: 12345, kill } as unknown as ChildProcess);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      vi.unstubAllEnvs();
    }
  });

  it('preserves argument boundaries, Unicode, and metacharacters without a shell', async () => {
    const args = ['', 'space here', 'quotes " here', 'a&b|c<>d', '%PATH%', '$HOME', 'linen 🧶'];
    const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args], tempDir(), 10_000);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.runIf(process.platform === 'win32')('runs an npm-style cmd shim in a spaced directory with literal arguments', async () => {
    const dir = join(tempDir(), 'space here', 'node_modules', '.bin');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'echo.mjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const shim = join(dir, 'echo.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`);
    const args = ['space here', 'quoted "value"', 'a&b|c<>d', '%PATH%', 'linen 🧶'];
    const result = await run(shim, args, dir, 10_000);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    const probe = await spawnProbe(shim, ['probe'], { cwd: dir, env: process.env, stdin: '', timeoutMs: 10_000 });
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(['probe']);
  });

  it.runIf(process.platform === 'win32').each(['probe', 'worker'] as const)('executes PowerShell script effects and preserves exit 7 through %s', async (mode) => {
    const dir = join(tempDir(), 'powershell script');
    mkdirSync(dir);
    const marker = join(dir, 'execution marker.txt');
    const script = join(dir, 'execution.ps1');
    writeFileSync(script, `param([string] $Marker, [string] $Mode)
      $ErrorActionPreference = 'Stop'
      $value = 'worker'
      if ($Mode -eq 'probe') { $value = [Console]::In.ReadLine() }
      [IO.File]::WriteAllText($Marker, "executed:$value")
      [Console]::Out.Write("executed:$value")
      [Console]::Error.Write('intentional-exit')
      exit 7`);
    expect(process.env.SystemRoot).toBeTruthy();
    const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-File', script, marker, mode];
    const result = mode === 'probe'
      ? await spawnProbe(powershell, args, { cwd: dir, env: process.env, stdin: 'probe-input\n', timeoutMs: 10_000 })
      : await run(powershell, args, dir, 10_000);
    expect(result.exitCode, result.stderr).toBe(7);
    expect(result.timedOut).toBe(false);
    const expected = mode === 'probe' ? 'executed:probe-input' : 'executed:worker';
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe('intentional-exit');
    expect(readFileSync(marker, 'utf8')).toBe(expected);
  }, 20_000);

  it.runIf(process.platform === 'win32')('preserves an intentional shell exit 1 without reporting a missing executable', async () => {
    const result = await spawnProbe('echo shell-executed&exit /b 1', [], {
      cwd: tempDir(), env: process.env, stdin: '', timeoutMs: 10_000, shell: true,
    });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, stderr: '' });
    expect(result.stdout.trim()).toBe('shell-executed');
  });

  it.runIf(process.platform === 'win32')('reaps the worker and its descendant when a cmd launcher times out', async () => {
    const dir = tempDir();
    const script = join(dir, 'worker.mjs');
    writeFileSync(script, `import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.stdout.write(String(child.pid)); setInterval(()=>{},1000);`);
    const shim = join(dir, 'worker.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0worker.mjs"\r\n`);
    for (const mode of ['deadline', 'probe', 'idle']) {
      const result = mode === 'probe'
        ? await spawnProbe(shim, [], { cwd: dir, env: process.env, stdin: '', timeoutMs: 2000 })
        : await run(shim, [], dir, mode === 'idle' ? 10_000 : 2000, undefined, undefined, undefined, mode === 'idle' ? 2000 : undefined);
      const pid = Number(result.stdout);
      try {
        expect(result.timedOut).toBe(mode !== 'idle');
        if (mode === 'idle') expect('idleTimedOut' in result && result.idleTimedOut).toBe(true);
        expect(Number.isSafeInteger(pid) && pid > 0, result.stderr).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped as required. */ }
        }
      }
    }
  });
});
