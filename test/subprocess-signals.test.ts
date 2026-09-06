import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBuilt, PROJECT_ROOT } from './helpers/build.js';
import { useTempResources } from './helpers.js';

// Fix B (round-1): run() spawns DETACHED children (each its own process group), so a terminal signal to
// heddle no longer reaches the workers. run() therefore installs once SIGINT/SIGTERM/SIGHUP handlers
// that group-kill every live child and RE-RAISE the signal (never process.exit). This proves that
// end-to-end against the BUILT module: a wrapper starts a long-lived detached child via run(), we
// SIGTERM the wrapper, and assert (a) the wrapper dies BY the re-raised signal and (b) the detached
// child's group is reaped. Without Fix B the detached child would outlive the wrapper.

const poll = async (fn: () => boolean, ms = 10_000, step = 25): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe.skipIf(process.platform === 'win32')('subprocess run() — parent-cancel reaping (Fix B, built module)', () => {
  const { tempDir } = useTempResources('heddle-subprocess-signals-');

  it('group-kills a detached child and re-raises the signal when the parent is SIGTERMed', async () => {
    await ensureBuilt();
    const dir = tempDir();
    const childPidfile = join(dir, 'child.pid');
    const subprocessJs = join(PROJECT_ROOT, 'dist/adapters/subprocess.js');
    // The run() child writes its OWN pid (run() does not expose child.pid to the wrapper) then lives 60s.
    // The wrapper BLOCKS FOREVER after calling run() so the reaped child's 'close' resolving run() can't
    // let the wrapper exit 0 before the re-raised SIGTERM lands — the signal must be what ends it.
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(childPidfile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
    const wrapperCode = [
      `import { run } from ${JSON.stringify(subprocessJs)};`,
      `void run(process.execPath, ['-e', ${JSON.stringify(childCode)}], process.cwd(), 60000);`,
      'await new Promise(() => {});',
    ].join('\n');
    const wrapperFile = join(dir, 'wrapper.mjs');
    writeFileSync(wrapperFile, wrapperCode);

    const wrapper = spawn(process.execPath, [wrapperFile], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    wrapper.stderr.setEncoding('utf8');
    wrapper.stderr.on('data', (d: string) => { stderr += d; });
    wrapper.stdout.resume();

    let childPid: number | undefined;
    try {
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
        wrapper.on('close', (code, signal) => resolveClose({ code, signal }));
      });

      expect(await poll(() => existsSync(childPidfile))).toBe(true);
      childPid = Number(readFileSync(childPidfile, 'utf8'));
      expect(childPid).toBeGreaterThan(0);
      expect(alive(childPid)).toBe(true);

      wrapper.kill('SIGTERM');
      const result = await closed;
      // Re-raised, not process.exit(): the wrapper dies BY the signal — code null, signal SIGTERM. A
      // handler that called process.exit() would give (code, null) and fail this. (stderr surfaced on
      // failure for diagnosis.)
      expect(result, stderr).toMatchObject({ code: null, signal: 'SIGTERM' });
      // The detached child's whole group was reaped by the handler. Without Fix B it would outlive the
      // wrapper and stay alive here.
      expect(await poll(() => !alive(childPid as number))).toBe(true);
    } finally {
      try { if (childPid !== undefined) process.kill(childPid, 'SIGKILL'); } catch { /* already reaped */ }
      try { wrapper.kill('SIGKILL'); } catch { /* already exited */ }
    }
  });
});
