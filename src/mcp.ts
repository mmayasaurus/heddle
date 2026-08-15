import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

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
 * afterwards. Returns null when no servers were requested.
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

export function materializeWorkerMcp(cwd: string, provider: string, serverNames: string[]): () => void {
  if (serverNames.length === 0) return () => { /* nothing to attach */ };

  // Codex reads its servers (memtrace, serena) from the user's global config — nothing to write,
  // and its known-set differs from the materializable set, so validate via codexApprovalFlags,
  // not here.
  if (provider === 'codex') return () => { /* no-op */ };

  const servers = resolveMcpServers(serverNames);
  switch (provider) {
    case 'cursor':
      return writeMergedMcpJson(join(cwd, '.cursor', 'mcp.json'), servers);
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

function writeMergedMcpJson(
  path: string, servers: Record<string, { command: string; args: string[] }>,
): () => void {
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, 'utf8') : null;
  mkdirSync(dirname(path), { recursive: true });

  let next: string;
  if (original !== null) {
    const parsed = JSON.parse(original) as { mcpServers?: Record<string, unknown> };
    parsed.mcpServers = { ...(parsed.mcpServers ?? {}), ...servers };
    next = JSON.stringify(parsed, null, 2);
  } else {
    next = JSON.stringify({ mcpServers: servers }, null, 2);
  }
  writeFileSync(path, next, 'utf8');

  return () => {
    if (original !== null) {
      writeFileSync(path, original, 'utf8');
      return;
    }
    // Only remove a file we created, and only if untouched since — never discard others' work.
    try {
      if (readFileSync(path, 'utf8') === next) unlinkSync(path);
    } catch { /* gone or unreadable — leave it */ }
  };
}
