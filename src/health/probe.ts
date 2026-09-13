import { run } from '../adapters/subprocess.js';

export type CheckOutcome = 'ok' | 'warn' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  kind: 'binary' | 'login' | 'catalog' | 'config' | 'freshness' | 'comms';
  provider?: string;
  outcome: CheckOutcome;
  detail: string;
  hint?: string;
}

export interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  execFile: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<ProbeResult>;
  now: () => Date;
  paths: {
    routing?: string;
    lanes?: string;
    projects?: string;
    accounts?: string;
    secrets?: string;
    comms?: string;
    operatorToken?: string;
  };
  timeouts?: {
    binaryMs?: number;
    loginMs?: number;
    catalogMs?: number;
    graceMs?: number;
  };
}

// This bounds retained output; bounding peak memory while reading belongs in the shared runner (HED-420).
export const MAX_STREAM_BYTES = 1_024 * 1_024;

export function capStream(value: string): string {
  if (Buffer.byteLength(value) <= MAX_STREAM_BYTES) {
    return value;
  }

  let bytes = 0;
  let out = '';

  for (const char of value) {
    const size = Buffer.byteLength(char);

    if (bytes + size > MAX_STREAM_BYTES) {
      break;
    }

    out += char;
    bytes += size;
  }

  return `${out}…[truncated]`;
}

export function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<ProbeResult> {
  return run(cmd, args, process.cwd(), opts.timeoutMs).then((probe) => ({
    ...probe,
    stdout: capStream(probe.stdout),
    stderr: capStream(probe.stderr),
  }));
}

export function sanitize(detail: string): string {
  return detail
    .trim()
    .replace(/[\r\n]+/g, '; ')
    .replace(/[ \t]+/g, ' ')
    .slice(0, 240);
}

export function result(
  outcome: CheckOutcome,
  detail: string,
  hint?: string,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  return hint ? { outcome, detail: sanitize(detail), hint } : { outcome, detail: sanitize(detail) };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timeoutResult(
  cli: string,
  timeoutMs: number,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  return result(
    'warn',
    `timed out after ${timeoutMs / 1_000}s — unverified, not proven broken`,
    `re-run; if it persists see docs/LANDMINES.md (${cli})`,
  );
}

export async function probe(
  deps: DoctorDeps,
  cmd: string,
  args: string[],
  timeoutMs: number,
  graceMs: number,
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      deps.execFile(cmd, args, { timeoutMs }),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
          timeoutMs + graceMs,
        );
      }),
    ]);
  } catch (error) {
    return { stdout: '', stderr: errorText(error), exitCode: null, timedOut: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function probeFailure(
  probe: ProbeResult,
  cli: string,
  timeoutMs: number,
  installHint: string,
): Omit<CheckResult, 'id' | 'kind' | 'provider'> | undefined {
  if (probe.timedOut) {
    return timeoutResult(cli, timeoutMs);
  }

  if (probe.exitCode !== null) {
    return undefined;
  }

  if (/\bENOENT\b/.test(probe.stderr)) {
    return result('fail', 'missing binary (spawn ENOENT)', installHint);
  }

  const errno = probe.stderr.match(/\bE[A-Z]{2,}\b/)?.[0];

  if (errno) {
    return result('fail', `cannot execute (${errno})`, installHint);
  }

  return result('warn', 'probe could not run — unverified');
}
