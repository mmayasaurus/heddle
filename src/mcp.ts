import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { withFileLock } from './matlock.js';
import type { MaterializeOpts } from './skillpacks.js';

/**
 * Worker MCP attachment — grants a cross-provider worker the code-discovery tools its task needs.
 *
 * Each CLI reads MCP config differently, so heddle materializes the right file into the worker's
 * cwd (mirroring the skill-pack materialization) and restores it afterward.
 *
 * Registry is intentionally small and VERIFIED. memtrace has a uniform stdio invocation and is
 * the Commandment-#2 discovery tool. Serena is deferred: its per-host `--context` wiring is not
 * uniform across providers, so shipping it blind would violate the no-guessing rule.
 */
/**
 * Servers heddle can MATERIALIZE into a worker's own project config (cursor/agy). memtrace has a
 * uniform stdio invocation; serena's context differs per host so it is not materialized here.
 */
export const WORKER_MCP_SERVERS: Record<string, { command: string; args: string[] }> = {
  memtrace: { command: 'memtrace', args: ['mcp'] },
};

/**
 * Full self-contained CODEX MCP server definitions. Codex workers run with `--ignore-user-config`
 * (efficiency + governance: sheds the ~13k global fleet instructions, argent's ~90 tools, serena,
 * node_repl, etc. — verified ~124k vs multi-hundred-k input), so the servers a worker needs must be
 * defined inline via `-c`, not inherited from ~/.codex. Verified: memtrace reachable this way.
 */
const CODEX_MCP_DEFS: Record<string, { command: string; args: string[] }> = {
  memtrace: { command: 'memtrace', args: ['mcp'] },
  serena: { command: 'codex-serena', args: ['start-mcp-server', '--context', 'codex', '--project-from-cwd'] },
};

/**
 * `-c` overrides that (a) fully define each requested MCP server (so it exists under
 * --ignore-user-config) and (b) pre-approve its tools — without approval, codex headless cancels
 * every tool call with "user cancelled MCP tool call" (no TTY). Verified live.
 */
export function codexMcpFlags(serverNames: string[]): string[] {
  const flags: string[] = [];
  for (const n of serverNames) {
    const def = CODEX_MCP_DEFS[n];
    if (!def) {
      throw new Error(`unknown codex MCP server "${n}". Known: ${Object.keys(CODEX_MCP_DEFS).join(', ')}`);
    }
    flags.push('-c', `mcp_servers.${n}.command=${JSON.stringify(def.command)}`);
    flags.push('-c', `mcp_servers.${n}.args=${JSON.stringify(def.args)}`);
    flags.push('-c', `mcp_servers.${n}.default_tools_approval_mode="approve"`);
  }
  return flags;
}

export function resolveMcpServers(names: string[]): Record<string, { command: string; args: string[] }> {
  const out: Record<string, { command: string; args: string[] }> = {};
  for (const n of names) {
    const s = WORKER_MCP_SERVERS[n];
    if (!s) {
      throw new Error(
        `unknown worker MCP server "${n}". Known: ${Object.keys(WORKER_MCP_SERVERS).join(', ')}`,
      );
    }
    out[n] = s;
  }
  return out;
}

/**
 * Attach MCP servers for a worker in `cwd`. Returns a restore function.
 *
 * - codex: memtrace is already enabled in the user's global `~/.codex/config.toml` (verified), so
 *   codex workers get it with no per-task file. If a requested server is NOT the globally-present
 *   memtrace, that's surfaced by resolveMcpServers rather than silently missing.
 * - cursor: project `.cursor/mcp.json` (mcpServers key — verified format).
 * - gemini/agy: project `.agents/mcp_config.json` — format NOT yet verified against agy docs, so
 *   this path throws rather than write a guessed schema. (Tracked follow-up.)
 */
/**
 * Validate an MCP attachment request WITHOUT writing anything — the dispatcher calls this before it
 * opens a ledger row (HED-19: an unknown server / unsupported provider must fail fast, leaving no
 * orphan row and no mutated worktree). Same rules as materializeWorkerMcp + codexMcpFlags.
 */
export function validateWorkerMcp(provider: string, serverNames: string[]): void {
  if (serverNames.length === 0) return;
  if (provider === 'codex') { codexMcpFlags(serverNames); return; }
  if (provider === 'claude') { resolveMcpServers(serverNames); return; } // written to a temp --mcp-config file at run time
  if (provider === 'gemini') {
    throw new Error(
      'worker MCP attachment for agy/gemini is not implemented yet: the .agents/mcp_config.json ' +
      'schema has not been verified against Antigravity docs, and heddle does not write guessed ' +
      'config. Dispatch without --mcp for gemini, or use a codex/cursor worker for discovery tasks.',
    );
  }
  resolveMcpServers(serverNames);
}

/**
 * Claude headless workers take MCP servers from `--mcp-config <file>` (+ `--strict-mcp-config`), so
 * heddle writes a per-dispatch JSON in the OS temp dir — nothing touches the worktree — and removes it
 * afterwards. ALWAYS returns a file — an empty {mcpServers:{}} when none were requested — because
 * --strict-mcp-config must always be passed to hide the operator's global servers.
 */
export function claudeMcpConfigFile(serverNames: string[]): { path: string; cleanup: () => void } {
  // An EMPTY config is deliberate: paired with --strict-mcp-config it hides the operator's global
  // servers from the worker (see src/adapters/claude.ts).
  const servers = serverNames.length ? resolveMcpServers(serverNames) : {};
  const dir = mkdtempSync(join(tmpdir(), 'heddle-claude-mcp-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
  return { path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

export function materializeWorkerMcp(cwd: string, provider: string, serverNames: string[], opts: MaterializeOpts): () => void {
  if (serverNames.length === 0) return () => { /* nothing to attach */ };

  // Codex reads its servers (memtrace, serena) from the user's global config — nothing to write,
  // and its known-set differs from the materializable set, so validate via codexApprovalFlags,
  // not here.
  if (provider === 'codex') return () => { /* no-op */ };

  const servers = resolveMcpServers(serverNames);
  switch (provider) {
    case 'cursor':
      return writeMergedMcpJson(join(cwd, '.cursor', 'mcp.json'), servers, opts);
    case 'gemini':
      throw new Error(
        'worker MCP attachment for agy/gemini is not implemented yet: the .agents/mcp_config.json ' +
        'schema has not been verified against Antigravity docs, and heddle does not write guessed ' +
        'config. Dispatch without --mcp for gemini, or use a codex/cursor worker for discovery tasks.',
      );
    default:
      return () => { /* unknown provider — nothing to attach */ };
  }
}

/**
 * The sidecar that makes a JSON config concurrency-safe (JSON carries no comment markers, so the
 * AGENTS.md per-block trick does not transfer — HED-56). It records the PRE-heddle file content
 * once (`original`, captured by the first attaching dispatch) and one server list per live
 * dispatch (`refs`). Every mutation rebuilds the merged file from original + all live refs, so the
 * merged view is order-independent; the LAST ref out restores the original bytes (or deletes a
 * file heddle created) and removes the sidecar. Dead refs (crashed dispatches, per the liveness
 * oracle) are dropped on the next mutation.
 */
interface McpSidecar {
  original: string | null;
  refs: Record<string, string[]>;
}

function sidecarPath(path: string): string {
  return join(dirname(path), '.heddle-mcp-refs.json');
}

function readSidecar(path: string): McpSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(path), 'utf8')) as McpSidecar;
    return raw && typeof raw === 'object' && raw.refs && typeof raw.refs === 'object'
      ? { original: typeof raw.original === 'string' ? raw.original : null, refs: raw.refs }
      : null;
  } catch {
    return null;
  }
}

function mergedContent(sidecar: McpSidecar): string {
  const base = sidecar.original !== null
    ? (JSON.parse(sidecar.original) as { mcpServers?: Record<string, unknown> })
    : { mcpServers: {} as Record<string, unknown> };
  const merged: Record<string, unknown> = { ...(base.mcpServers ?? {}) };
  for (const list of Object.values(sidecar.refs)) {
    for (const name of list) merged[name] = WORKER_MCP_SERVERS[name] ?? merged[name];
  }
  return JSON.stringify({ ...base, mcpServers: merged }, null, 2);
}

function writeMergedMcpJson(
  path: string, servers: Record<string, { command: string; args: string[] }>, opts: MaterializeOpts,
): () => void {
  const ownId = String(opts.dispatchId);
  const lock = join(dirname(path), '.heddle-mcp.lock');

  withFileLock(lock, () => {
    mkdirSync(dirname(path), { recursive: true });
    const sidecar = readSidecar(path)
      ?? { original: existsSync(path) ? readFileSync(path, 'utf8') : null, refs: {} };
    for (const id of Object.keys(sidecar.refs)) {
      if (id !== ownId && opts.isLive && !opts.isLive(id)) delete sidecar.refs[id]; // dead dispatch
    }
    sidecar.refs[ownId] = Object.keys(servers);
    writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
    writeFileSync(path, mergedContent(sidecar), 'utf8');
  });

  return () => {
    withFileLock(lock, () => {
      try {
        const sidecar = readSidecar(path);
        if (!sidecar || !(ownId in sidecar.refs)) return; // nothing of ours recorded — leave it
        delete sidecar.refs[ownId];
        if (Object.keys(sidecar.refs).length === 0) {
          // Last one out restores the pre-heddle state exactly.
          if (sidecar.original !== null) writeFileSync(path, sidecar.original, 'utf8');
          else { try { unlinkSync(path); } catch { /* already gone */ } }
          try { unlinkSync(sidecarPath(path)); } catch { /* already gone */ }
        } else {
          writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
          writeFileSync(path, mergedContent(sidecar), 'utf8');
        }
      } catch { /* unreadable — leave the worktree as it is rather than guess */ }
    });
  };
}
