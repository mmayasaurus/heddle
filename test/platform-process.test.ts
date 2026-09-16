import { mkdirSync, writeFileSync } from 'node:fs';
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

  it.runIf(process.platform === 'win32')('reaps the worker and its descendant when a cmd launcher times out', async () => {
    const dir = tempDir();
    const script = join(dir, 'worker.mjs');
    writeFileSync(script, `import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      process.stdout.write(String(child.pid)); setInterval(()=>{},1000);`);
    const shim = join(dir, 'worker.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0worker.mjs"\r\n`);
    const result = await run(shim, [], dir, 2000);
    const pid = Number(result.stdout);
    expect(result.timedOut).toBe(true);
    expect(Number.isSafeInteger(pid) && pid > 0, result.stderr).toBe(true);
    try {
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped as required. */ }
    }
  });
});
