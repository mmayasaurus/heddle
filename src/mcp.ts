import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
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
        `unknown worker MCP server "${n}". Available: ${Object.keys(WORKER_MCP_SERVERS).join(', ')}.` +
          // Only claim serena is codex-only when serena is what was actually asked for — otherwise this
          // misleads for any other unknown name (copilot/cubic #68). This fn is shared by claude
          // (ephemeral --mcp-config) too, so keep the wording provider-neutral (codacy #68).
          (n === 'serena' ? ' (serena is codex-only — attached via inline -c flags, never materialized.)' : ''),
      );
    }
    out[n] = s;
  }
  return out;
}

/**
 * Does this provider have an implemented worker-MCP attachment path at all? DERIVED from
 * validateWorkerMcp (not a parallel hardcoded check) so the two can never drift (gitar #67) — it
 * probes the attachment gate with the canonical, always-registered `memtrace` server and reports
 * whether it is accepted. Today only the `gemini` provider key (the agy / Antigravity CLI behind it)
 * lacks a path and throws. Used by the routing CI invariant (routing.test.ts): every provider an
 * mcp-carrying task class can resolve to — primary, fallback, AND every reviewer_pool entry — must be
 * worker-MCP-attachable, so an mcp class can never route to a provider that would hard-fail the
 * dispatch. HED-249 replaced HED-205's runtime graceful-degrade (silently dropping mcp for a gemini
 * target) with this config-time guard: refusing loudly at the table beats a silent discovery-less run.
 */
export function workerMcpSupported(provider: string): boolean {
  try {
    validateWorkerMcp(provider, ['memtrace']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an MCP attachment request WITHOUT writing anything — the dispatcher calls this before it
 * opens a ledger row (HED-19: an unknown server / unsupported provider must fail fast, leaving no
 * orphan row and no mutated worktree). Same rules as materializeWorkerMcp + codexMcpFlags.
 */
export function validateWorkerMcp(provider: string, serverNames: string[]): void {
  if (serverNames.length === 0) return;
  if (provider === 'codex') { codexMcpFlags(serverNames); return; }
  if (provider === 'claude') { resolveMcpServers(serverNames); return; } // written to a temp --mcp-config file at run time
  if (provider === 'cursor') { resolveMcpServers(serverNames); return; } // materialized into .cursor/mcp.json
  if (provider === 'gemini') {
    throw new Error(
      'worker MCP attachment for the gemini provider (agy/Antigravity CLI) is not implemented yet: the ' +
      '.agents/mcp_config.json schema has not been verified against Antigravity docs, and heddle does ' +
      'not write guessed config. Dispatch without --mcp for gemini, or use a codex/cursor worker.',
    );
  }
  // Any OTHER provider has no worker-MCP attachment path — throw rather than fall through to a pass
  // (and materializeWorkerMcp's default no-op), so a class-default mcp on it is DROPPED, not kept-but-
  // never-attached (qodo/cubic #67). resolveRoute rejects unknown providers upstream; this keeps the
  // gate correct in isolation and makes workerMcpSupported (which probes it) right for them too.
  throw new Error(`worker MCP attachment is not supported for provider "${provider}" (supported: codex, claude, cursor)`);
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

/**
 * Attach MCP servers for a worker in `cwd`. Returns a restore function.
 *
 * - codex: workers get their MCP servers from inline `-c mcp_servers.*` overrides emitted by
 *   codexMcpFlags at invocation. `--ignore-user-config` sheds global config, so this function
 *   writes no per-task file for codex.
 * - claude: no-op — its MCP is a temp `--mcp-config` file written by claudeMcpConfigFile, never the worktree.
 * - cursor: project `.cursor/mcp.json` (mcpServers key — verified format).
 * - gemini/agy: project `.agents/mcp_config.json` — format NOT yet verified against agy docs, so
 *   this path throws rather than write a guessed schema. (Tracked follow-up.)
 */
export function materializeWorkerMcp(cwd: string, provider: string, serverNames: string[], opts: MaterializeOpts): () => void {
  if (serverNames.length === 0) return () => { /* nothing to attach */ };

  // Codex servers and their tool approval come from codexMcpFlags inline `-c` overrides (including
  // default_tools_approval_mode="approve"), so there is nothing to materialize here. Codex server
  // validation happens via codexMcpFlags (called by validateWorkerMcp), not in this function.
  // codex + claude write nothing into the worktree — codex via inline `-c` flags (codexMcpFlags),
  // claude via a temp `--mcp-config` file (claudeMcpConfigFile). Both are no-ops here; claude is
  // never actually routed through this fn (dispatch handles it separately), but returning a no-op
  // keeps it consistent with validateWorkerMcp, which lists claude as supported (codacy #68).
  if (provider === 'codex' || provider === 'claude') return () => { /* no-op */ };

  const servers = resolveMcpServers(serverNames);
  switch (provider) {
    case 'cursor':
      return writeMergedMcpJson(join(cwd, '.cursor', 'mcp.json'), servers, opts);
    case 'gemini':
      throw new Error(
        'worker MCP attachment for the gemini provider (agy/Antigravity CLI) is not implemented yet: the ' +
        '.agents/mcp_config.json schema has not been verified against Antigravity docs, and heddle does ' +
        'not write guessed config. Dispatch without --mcp for gemini, or use a codex/cursor worker.',
      );
    default:
      // No attachment path — throw rather than a silent no-op that keeps mcp in the list but never
      // attaches it (qodo/cubic #67). validateWorkerMcp rejects this first in the dispatch flow.
      throw new Error(`worker MCP attachment is not supported for provider "${provider}" (supported: codex, claude, cursor)`);
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

/** Missing sidecar → null (fresh state). A CORRUPT sidecar is different: treating it as missing
 *  would silently drop other live dispatches' refs — it is preserved under a .corrupt-<ts> name
 *  (never deleted) and surfaced, and the caller starts fresh from the current file. */
function readSidecar(path: string): McpSidecar | null {
  const sc = sidecarPath(path);
  if (!existsSync(sc)) return null;
  try {
    const raw = JSON.parse(readFileSync(sc, 'utf8')) as McpSidecar;
    if (raw && typeof raw === 'object' && raw.refs && typeof raw.refs === 'object' && !Array.isArray(raw.refs)) {
      const refs: Record<string, string[]> = {};
      for (const [id, list] of Object.entries(raw.refs)) {
        // shape-validate each entry: server lists are arrays of strings
        if (Array.isArray(list) && list.every((x) => typeof x === 'string')) refs[id] = list;
      }
      return { original: typeof raw.original === 'string' ? raw.original : null, refs };
    }
    throw new Error('unexpected shape');
  } catch (err) {
    const quarantine = `${sc}.corrupt-${Date.now()}`;
    try { renameSync(sc, quarantine); } catch { /* even the rename failed — leave it */ }
    process.stderr.write(`heddle: MCP sidecar ${sc} was unreadable (${err instanceof Error ? err.message : String(err)}) — preserved as ${quarantine}; starting fresh\n`);
    return null;
  }
}

function mergedContent(sidecar: McpSidecar): string {
  const base = sidecar.original !== null
    ? (JSON.parse(sidecar.original) as { mcpServers?: Record<string, unknown> })
    : { mcpServers: {} as Record<string, unknown> };
  const merged: Record<string, unknown> = { ...base.mcpServers };
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
  // The lock lives inside the config dir — create the dir FIRST or two fresh processes both fail
  // the lock mkdir with ENOENT and race the file unlocked.
  mkdirSync(dirname(path), { recursive: true });

  withFileLock(lock, () => {
    const sidecar = readSidecar(path)
      ?? { original: existsSync(path) ? readFileSync(path, 'utf8') : null, refs: {} };
    // A malformed pre-existing config must fail BEFORE any state is persisted — writing the
    // sidecar first would leave a half-mutated pair behind the crash.
    if (sidecar.original !== null) {
      try { JSON.parse(sidecar.original); } catch {
        throw new Error(`${path} exists but is not valid JSON — fix or remove it before dispatching a worker with MCP attached`);
      }
    }
    for (const id of Object.keys(sidecar.refs)) {
      if (id !== ownId && opts.isLive && !opts.isLive(id)) delete sidecar.refs[id]; // dead dispatch
    }
    sidecar.refs[ownId] = Object.keys(servers);
    const merged = mergedContent(sidecar); // compute BEFORE persisting anything
    writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
    writeFileSync(path, merged, 'utf8');
  });

  return () => {
    withFileLock(lock, () => {
      try {
        const sidecar = readSidecar(path);
        if (!sidecar || !(ownId in sidecar.refs)) return; // nothing of ours recorded — leave it
        // Tamper check: if the file no longer matches what the sidecar says heddle last wrote,
        // someone (the worker, a human) edited it mid-dispatch — NEVER rewrite or delete over
        // their bytes; drop only our ref so the bookkeeping stays truthful.
        const expected = mergedContent(sidecar);
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        const tampered = current !== expected;
        delete sidecar.refs[ownId];
        if (tampered) {
          process.stderr.write(`heddle: ${path} was edited during dispatch #${ownId} — leaving the file; removed only heddle's ref\n`);
          if (Object.keys(sidecar.refs).length === 0) { try { unlinkSync(sidecarPath(path)); } catch { /* already gone */ } }
          else writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
          return;
        }
        if (Object.keys(sidecar.refs).length === 0) {
          // Last one out restores the pre-heddle state exactly.
          if (sidecar.original !== null) writeFileSync(path, sidecar.original, 'utf8');
          else { try { unlinkSync(path); } catch { /* already gone */ } }
          try { unlinkSync(sidecarPath(path)); } catch { /* already gone */ }
        } else {
          writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
          writeFileSync(path, mergedContent(sidecar), 'utf8');
        }
      } catch (err) {
        process.stderr.write(`heddle: MCP restore for dispatch #${ownId} failed (${err instanceof Error ? err.message : String(err)}) — left as is\n`);
      }
    });
  };
}
