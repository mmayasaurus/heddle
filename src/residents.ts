import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readClaudeAccounts, type ClaudeAccount } from './capaware.js';

export interface ResidentLoad {
  count: number;
  weight: number;
}

export interface ResidentsDeps {
  /** Injectable command runner for hermetic tests (default: execFileSync). */
  exec?: (file: string, args: string[]) => string;
  /** Shared cross-consumer fixture: the env-bearing `ps` lines, bypassing pgrep/ps. Falls back to the
   *  HEDDLE_CENSUS_PS_FIXTURE env var (the same hook heddle-window-keeper.py's live_census honors). */
  psLines?: string[];
  accounts?: ClaudeAccount[];
  weightOf?: (letter: string) => number;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  env?: NodeJS.ProcessEnv;
}

// A surviving line must be an interactive fleet session: not a codex companion, not a captured shell
// snapshot, and not a headless `-p`/`--print` worker (those inherit HEDDLE_AGENT from the dispatching
// MCP server, so counting them would mis-attribute burn as a seat — R, 2026-09-14).
const SKIP = [/CODEX_COMPANION/, /shell-snapshot/, /(?:^|\s)(?:-p|--print)(?:\s|$)/];

function warn(deps: ResidentsDeps, detail: string): void {
  try {
    (deps.stderr ?? process.stderr).write(`heddle: warning: resident census unavailable (${detail})\n`);
  } catch {
    // A missing stderr must never turn an unavailable census into a throwing picker path.
  }
}

function parseFixture(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((line) => typeof line === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/** Normalize a config dir for exact registry matching: expand a leading ~, then path.resolve (which
 *  collapses ./.. and any trailing slash). Deliberately NOT realpath — see the byNormalizedDir note below. */
function normalizeConfigDir(dir: string): string {
  const expanded = dir === '~' ? homedir() : dir.startsWith('~/') ? `${homedir()}/${dir.slice(2)}` : dir;
  return resolve(expanded);
}

/**
 * Census live INTERACTIVE Claude sessions per account, weighted, for batch placement. This mirrors the
 * counted set of heddle-window-keeper.py's `live_census` byte-for-byte (same source, skips, exact config-dir
 * attribution, and invalidation — so keeper and picker never disagree) and ADDS a per-session weight
 * from HEDDLE_AGENT (the letter is only the weight-table index; a session with no letter is a plain 1.0
 * seat). Sessions are keyed by ACCOUNT, not by letter.
 *
 * Returns `null` when residency cannot be safely determined — any surviving line whose account is
 * ambiguous, or a broken census mechanism — rather than a partial count. Under-counting is the dangerous
 * direction for placement (an emptier-looking account gets stacked), so the caller degrades to
 * residency-unaware placement rather than trusting a guess (R's inversion, 2026-09-14). An authoritative
 * empty (no interactive `claude` processes, or all of them skipped) is a real `{}`, not null.
 */
export function censusClaudeResidents(deps: ResidentsDeps = {}): Map<string, ResidentLoad> | null {
  const env = deps.env ?? process.env;
  const accounts = deps.accounts ?? readClaudeAccounts();
  const weightOf = deps.weightOf ?? (() => 1);

  let lines: string[];
  const fixture = deps.psLines ?? parseFixture(env.HEDDLE_CENSUS_PS_FIXTURE);
  if (fixture) {
    lines = fixture;
  } else {
    const exec = deps.exec ?? ((file: string, args: string[]) => execFileSync(file, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let pids: number[];
    try {
      // `-x claude` matches the interactive CLI process exactly, excluding `node`/`claudex`/path matches.
      pids = exec('pgrep', ['-x', 'claude']).split('\n')
        .map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch (error) {
      // pgrep status 1 is the documented "no matching process" — an authoritative empty, not a failure.
      if ((error as { status?: number }).status === 1) return new Map();
      warn(deps, 'pgrep command failed');
      return null;
    }
    lines = [];
    try {
      for (const pid of pids) {
        // `ps eww` appends the full environment to the command row; drop the header line.
        lines.push(...exec('ps', ['eww', String(pid)]).split('\n').slice(1));
      }
    } catch {
      warn(deps, 'ps environment inspection failed');
      return null;
    }
  }

  const surviving = lines.filter((line) => line.trim() !== '' && !SKIP.some((re) => re.test(line)));
  if (surviving.length === 0) return new Map();

  const defaults = accounts.filter((account) => account.configDir === null);
  // Exact normalized config-dir → account(s), so a matched session attributes to the RIGHT account (or
  // invalidates), never to a same-basename neighbour (codeant HED-514). This maps like the keeper's
  // config_to_id dict. We normalize with path.resolve, NOT realpath: realpath would collapse a
  // symlink-aliased pair (the known acct1≡acct3 case) into one key and null the census exactly when both
  // are resident, whereas resolve keeps distinct dirs distinct.
  const byNormalizedDir = new Map<string, ClaudeAccount[]>();
  for (const account of accounts) {
    if (account.configDir === null) continue;
    const key = normalizeConfigDir(account.configDir);
    const list = byNormalizedDir.get(key);
    if (list) list.push(account); else byNormalizedDir.set(key, [account]);
  }
  const residents = new Map<string, ResidentLoad>();
  for (const line of surviving) {
    const configDir = /(?:^|\s)CLAUDE_CONFIG_DIR=([^\s]+)/.exec(line)?.[1]?.replace(/^["']|["']$/g, '');
    const letter = /(?:^|\s)HEDDLE_AGENT=([A-Za-z0-9_-]+)/.exec(line)?.[1];
    // config-dir → account by UNIQUE exact match; env-less → the single default account IFF exactly one
    // exists. Zero matches (unmapped dir), a non-unique match, or 0/>1 defaults are all ambiguous, and
    // ANY unattributable session invalidates the whole census (never a partial or guessed count).
    const matches = configDir ? byNormalizedDir.get(normalizeConfigDir(configDir)) ?? [] : [];
    const account = configDir
      ? (matches.length === 1 ? matches[0] : null)
      : (defaults.length === 1 ? defaults[0] : null);
    if (!account) {
      warn(deps, `session on ${configDir ?? 'the default config dir'} maps to no single account`);
      return null;
    }
    const prior = residents.get(account.id) ?? { count: 0, weight: 0 };
    residents.set(account.id, { count: prior.count + 1, weight: prior.weight + (letter ? weightOf(letter) : 1) });
  }
  return residents;
}
