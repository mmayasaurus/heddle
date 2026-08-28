import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isCursorNativeModel } from './capaware.js';
import type { WorkerResult } from './types.js';

export const DEFAULT_ROTATION_ACCOUNTS_PATH = join(homedir(), '.heddle', 'accounts.json');
export const DEFAULT_COOLING_PATH = join(homedir(), '.heddle', 'usage', 'cooling.json');
export const DEFAULT_COOLDOWN_S = 3600;

export interface CodexAccount { id: string; codexHome: string | null; /** UTC civil day through which this account is preferred. */ preferUntil?: string; note?: string }
export interface CursorAccount { id: string; keyFile: string | null; /** UTC civil day through which this account is preferred. */ preferUntil?: string; note?: string }
export interface RotationAccounts { codex: CodexAccount[]; cursor: CursorAccount[] }
export interface CoolingLane { cooledAt: number; reason: string; cooldownS: number }
export interface CoolingStore { schemaVersion: 1; lanes: Record<string, CoolingLane> }
export interface CodexAccountPick { id: string; codexHome: string | null; reason: string }
export interface CursorAccountPick { id: string; keyFile: string | null; reason: string }

const emptyCooling = (): CoolingStore => ({ schemaVersion: 1, lanes: {} });
let coolingTempSequence = 0;

export function coolingTempPath(path: string): string {
  coolingTempSequence += 1;
  return `${path}.${process.pid}.${coolingTempSequence}.tmp`;
}

function dateIsActive(date: string | undefined, nowS: number): boolean {
  if (!date) return false;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(time) && nowS < time / 1000 + 86400;
}

function parseAccounts<T extends 'codex' | 'cursor'>(raw: unknown, kind: T): T extends 'codex' ? CodexAccount[] : CursorAccount[] {
  if (!Array.isArray(raw)) return [] as any;
  return raw.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && typeof (value as Record<string, unknown>).id === 'string')
    .map((value) => ({
      id: value.id as string,
      ...(kind === 'codex' ? { codexHome: typeof value.codexHome === 'string' && value.codexHome ? value.codexHome : null } : { keyFile: typeof value.keyFile === 'string' && value.keyFile ? value.keyFile : null }),
      preferUntil: typeof value.preferUntil === 'string' ? value.preferUntil : undefined,
      note: typeof value.note === 'string' ? value.note : undefined,
    })) as any;
}

/** Read the optional codex/cursor pools; missing or malformed input is deliberately a no-op. */
export function readRotationAccounts(path = process.env.HEDDLE_ACCOUNTS ?? DEFAULT_ROTATION_ACCOUNTS_PATH): RotationAccounts {
  try {
    if (!existsSync(path)) return { codex: [], cursor: [] };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return { codex: parseAccounts(raw.codex, 'codex'), cursor: parseAccounts(raw.cursor, 'cursor') };
  } catch { return { codex: [], cursor: [] }; }
}

/** Missing/corrupt cooling is unknown and therefore never blocks a worker. */
export function readCooling(path = DEFAULT_COOLING_PATH): CoolingStore {
  try {
    if (!existsSync(path)) return emptyCooling();
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CoolingStore>;
    if (raw.schemaVersion !== 1 || !raw.lanes || typeof raw.lanes !== 'object') return emptyCooling();
    const lanes: Record<string, CoolingLane> = {};
    for (const [key, lane] of Object.entries(raw.lanes)) {
      if (!lane || typeof lane !== 'object') continue;
      const value = lane as Partial<CoolingLane>;
      if (typeof value.cooledAt === 'number' && typeof value.reason === 'string' && typeof value.cooldownS === 'number') lanes[key] = { cooledAt: value.cooledAt, reason: value.reason, cooldownS: value.cooldownS };
    }
    return { schemaVersion: 1, lanes };
  } catch { return emptyCooling(); }
}

/** Best-effort durable store: rotation is advisory and an unwritable state file must not fail work. */
export function writeCooling(path: string, cooling: CoolingStore): void {
  const temp = coolingTempPath(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Advisory cooling accepts the cross-process read-modify-write race; a lost lane self-corrects on the next rate-limit.
    try { unlinkSync(temp); } catch { /* a missing temp is normal */ }
    writeFileSync(temp, JSON.stringify(cooling, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no-op */ }
    process.stderr.write(`heddle: could not write cooling state (${error instanceof Error ? error.message : String(error)})\n`);
  }
}

export function isCooled(cooling: CoolingStore, provider: 'codex' | 'cursor', id: string, nowS: number): boolean {
  const lane = cooling.lanes[`${provider}:${id}`];
  return Boolean(lane && nowS < lane.cooledAt + lane.cooldownS);
}

function coolingNote(cooling: CoolingStore, provider: 'codex' | 'cursor', id: string, nowS: number): string | null {
  const lane = cooling.lanes[`${provider}:${id}`];
  if (!lane || !isCooled(cooling, provider, id, nowS)) return null;
  return `${provider}-${id} cooling ${Math.ceil((lane.cooledAt + lane.cooldownS - nowS) / 60)}m`;
}

function preferred<T extends { preferUntil?: string }>(entries: T[], nowS: number): T[] {
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => Number(dateIsActive(b.entry.preferUntil, nowS)) - Number(dateIsActive(a.entry.preferUntil, nowS)) || a.index - b.index).map(({ entry }) => entry);
}

export function pickCodexAccount(registry: RotationAccounts, cooling: CoolingStore, pin: string | undefined, nowS: number): CodexAccountPick | null {
  if (pin) {
    const account = registry.codex.find((entry) => entry.id === pin || entry.codexHome === pin);
    if (account) return { id: account.id, codexHome: account.codexHome, reason: `account:${account.id} pinned${coolingNote(cooling, 'codex', account.id, nowS) ? ` (${coolingNote(cooling, 'codex', account.id, nowS)}; advisory)` : ''}` };
    return { id: basename(pin), codexHome: pin, reason: `account:${basename(pin)} pinned (manual CODEX_HOME)` };
  }
  const accounts = preferred(registry.codex, nowS);
  const skipped: string[] = [];
  for (const account of accounts) {
    const note = coolingNote(cooling, 'codex', account.id, nowS);
    if (note) { skipped.push(note); continue; }
    return { id: account.id, codexHome: account.codexHome, reason: `account:${account.id}${skipped.length ? ` (${skipped.join(', ')})` : ''}` };
  }
  const first = accounts[0];
  if (first) {
    const note = coolingNote(cooling, 'codex', first.id, nowS);
    return { id: first.id, codexHome: first.codexHome, reason: `account:${first.id} (${note}; advisory; all registered accounts cooling)` };
  }
  return null;
}

export function pickCursorAccount(model: string, registry: RotationAccounts, cooling: CoolingStore, nowS: number, unavailable = new Set<string>()): CursorAccountPick | null {
  const machine = registry.cursor.find((entry) => entry.keyFile === null);
  if (isCursorNativeModel(model)) return machine ? { id: machine.id, keyFile: null, reason: `account:${machine.id} cursor included pool` } : null;
  const skipped: string[] = [];
  for (const account of preferred(registry.cursor, nowS)) {
    if (account.keyFile === null) continue;
    if (unavailable.has(account.id)) { skipped.push(`cursor-${account.id} unavailable`); continue; }
    const note = coolingNote(cooling, 'cursor', account.id, nowS);
    if (note) { skipped.push(note); continue; }
    return { id: account.id, keyFile: account.keyFile, reason: `account:${account.id}${skipped.length ? ` (${skipped.join(', ')})` : ''}` };
  }
  return machine ? { id: machine.id, keyFile: null, reason: `account:${machine.id} cursor machine-login fallback${skipped.length ? ` (${skipped.join(', ')})` : ''}` } : null;
}

/** Read at dispatch time so a changed/removed key never gets cached in the registry path. */
export function readCursorKey(path: string): string | null {
  try {
    const mode = statSync(path).mode & 0o777;
    // Warn-and-use: refusing a readable loose key would silently degrade rotation to machine login.
    if ((mode & 0o077) !== 0) process.stderr.write(`heddle: Cursor key file ${path} permissions are looser than 0600\n`);
    const key = readFileSync(path, 'utf8').trim();
    return key || null;
  } catch { return null; }
}

export function classifyRotationRefusal(_provider: 'codex' | 'cursor', result: Pick<WorkerResult, 'ok' | 'output' | 'error' | 'exitCode'>): 'rate-limit' | null {
  if (result.ok) return null;
  const pattern = /rate.?limit|too many requests|\b429\b|(?<!disk )quota (?:exceeded|reached)|usage (?:limit|cap)|limit reached|you'?ve hit your|overloaded/i;
  return pattern.test((result.error ?? '').slice(-2000)) || pattern.test((result.output ?? '').slice(-2000)) ? 'rate-limit' : null;
}
