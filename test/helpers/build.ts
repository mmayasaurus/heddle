import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function sourceIsNewerThan(path: string, builtAt: number): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (await sourceIsNewerThan(entryPath, builtAt)) return true;
    } else if (entry.isFile() && entry.name.endsWith('.ts') && (await stat(entryPath)).mtimeMs > builtAt) {
      return true;
    }
  }
  return false;
}

async function needsBuild(): Promise<boolean> {
  const entrypoints = ['cli.js', 'mcp-server.js'];
  try {
    const timestamps = await Promise.all(entrypoints.map(async (entrypoint) => (
      await stat(join(PROJECT_ROOT, 'dist', entrypoint))
    ).mtimeMs));
    return sourceIsNewerThan(join(PROJECT_ROOT, 'src'), Math.min(...timestamps));
  } catch {
    return true;
  }
}

function runTsc(): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    execFile(
      process.execPath,
      [join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')],
      // `timeout` makes node kill tsc itself. The child is deliberately NOT registered with cli.ts's
      // cleanup set — build.ts is imported BY cli.ts, so reaching back would be a circular import —
      // and a self-killing child honours the no-orphans guarantee without that coupling.
      { cwd: PROJECT_ROOT, env: { PATH: process.env.PATH ?? '' }, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          rejectBuild(new Error(
            `heddle test harness build failed (tsc):\n${stdout}\n${stderr}\n${error.message}`,
          ));
          return;
        }
        resolveBuild();
      },
    );
  });
}

let built: Promise<void> | undefined;

/**
 * Fallback for running a single test file directly; `globalSetup` is what normally builds. Memoized
 * per process because `needsBuild()` walks all of `src/`, and without this every runCli()/startMcp()
 * call would repeat that scan. This is NOT the cross-worker lock — that is globalSetup's job, since
 * a module-level promise is per-worker and therefore not a lock at all.
 */
export function ensureBuilt(): Promise<void> {
  return (built ??= (async () => {
    if (await needsBuild()) await runTsc();
  })());
}
