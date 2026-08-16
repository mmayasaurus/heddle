import { execFileSync } from 'node:child_process';

/**
 * Owner-process liveness for the ledger's orphan sweep (HED-90): one `ps` call for all candidate
 * pids, parsed once, with pid-reuse-safe verdicts based on process START TIMES. Split from
 * ledger.ts to keep each file within the shop's length gates; ledger.ts re-exports the public
 * pieces so consumers keep a single import surface.
 */

/** What ps reports for one live pid: its start time (when parseable) and executable. */
export interface PsEntry {
  startedAtMs: number | null;
  comm: string;
}

/**
 * Parse `ps -p <pids> -o pid=,lstart=,comm=` (LANG=C) output ONCE into a pid table. lstart is the
 * 5-token ctime form ("Thu Aug 15 19:59:47 2026" — V8's Date.parse accepts it); whatever follows
 * is the executable (may contain spaces). Exported for tests.
 */
export function parsePsTable(output: string): Map<number, PsEntry> {
  const table = new Map<number, PsEntry>();
  for (const line of output.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const pid = Number(tokens[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const lstart = tokens.slice(1, 6).join(' ');
    const startedAt = Date.parse(lstart);
    table.set(pid, {
      startedAtMs: Number.isFinite(startedAt) ? startedAt : null,
      comm: tokens.slice(6).join(' '),
    });
  }
  return table;
}

/** ps reports whole seconds and our own clock reading is not simultaneous with ps's. */
const OWNER_START_SLOP_MS = 15_000;

/**
 * Is the process at `pid` the SAME process instance that recorded the row?
 *   - pid absent from a TRUSTED ps table → gone (`false`);
 *   - both start times known → same instance iff they agree within slop (`true`/`false`) — a
 *     recycled pid belongs to a NEWER process, so its start time cannot match;
 *   - otherwise → UNKNOWN (`null`): executable names can neither prove identity (a reused pid may
 *     run another `node`) nor safely disprove it (kernels report thread names and truncate to 15
 *     chars), so comm is recorded for humans but never decides — such rows close via the age rule.
 * Exported for tests.
 */
export function ownerVerdict(
  entry: PsEntry | undefined,
  recordedStartMs: number | null,
): boolean | null {
  if (entry === undefined) return false;
  if (recordedStartMs != null && entry.startedAtMs != null) {
    return Math.abs(entry.startedAtMs - recordedStartMs) <= OWNER_START_SLOP_MS;
  }
  return null;
}

/**
 * One ps call for all candidate pids → a probe closure. Verdict semantics:
 *   - ps succeeded, or exited 1 (its documented "some pids not found" status): the output is an
 *     authoritative table — a missing pid IS gone;
 *   - any other failure (unsupported flags, restricted /proc, sandbox): UNKNOWN (`null`) for every
 *     pid — the sweep never closes a row on a hunch.
 */
export function makePsProbe(rows: Record<string, unknown>[]): OwnerProbe {
  // No `ps` on Windows: liveness is explicitly UNKNOWN there (rows still close via the age rule).
  if (process.platform === 'win32') return () => null;
  const pids = [...new Set(rows.map((r) => Number(r.owner_pid)).filter((p) => Number.isFinite(p) && p > 0))];
  if (pids.length === 0) return () => null;
  // The sweeping process itself rides along as a SENTINEL: it is definitionally alive, so a parsed
  // table that lacks it means the ps output is untrustworthy (busybox/alpine ps also exits 1 for
  // unsupported flags, with empty stdout) — UNKNOWN for every pid, never "everything is gone".
  const sentinel = process.pid;
  let output: string | null;
  try {
    output = execFileSync('ps', ['-p', [...new Set([sentinel, ...pids])].join(','), '-o', 'pid=,lstart=,comm='], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    output = e.status === 1 ? (e.stdout ?? '') : null;
  }
  if (output === null) return () => null;
  const table = parsePsTable(output);
  if (!table.has(sentinel)) return () => null;
  return (pid, startedAtMs) => ownerVerdict(table.get(pid), startedAtMs);
}

/** Injectable owner-liveness check: true = same process instance, false = gone, null = unknown. */
export type OwnerProbe = (pid: number, startedAtMs: number | null) => boolean | null;

