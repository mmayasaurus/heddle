import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { withFileLock } from './matlock.js';
import type { MaterializeOpts } from './skillpacks.js';
import { ENFORCEABLE } from './capabilities.js';
import { clientFileSource, serverDefinitions, type FleetClient } from './client-config.js';

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
 * Servers heddle can MATERIALIZE into a worker's own project config. memtrace has a
 * uniform stdio invocation; serena's context differs per host so it is not materialized here.
 */
export const WORKER_MCP_SERVERS: Record<string, { command: string; args: string[] }> = {
  memtrace: { command: 'memtrace', args: ['mcp'] },
};

const NATIVE_CLIENT_BY_PROVIDER: Record<string, FleetClient | undefined> = {
  codex: 'codex', cursor: 'cursor', 'gemini-cli': 'gemini', opencode: 'opencode',
};

/**
 * True only when this worktree has Heddle's generated native MCP pair for the provider. Dispatch
 * uses this as the opt-in boundary for minting a durable child identity: ordinary worker runs must
 * not create comms participants merely because a provider happens to be native.
 */
export function nativeClientIntegrationInstalled(cwd: string, provider: string, refuseUnverified = false): boolean {
  const client = NATIVE_CLIENT_BY_PROVIDER[provider];
  if (!client) return false;
  const relative = {
    codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', opencode: 'opencode.json',
  }[client];
  const path = join(resolve(cwd), relative);
  let namedEntries = false;
  try {
    if (!existsSync(path)) return false;
    let raw: string | null;
    try { raw = clientFileSource(path); }
    catch {
      namedEntries = true; // The client follows this config; ownership cannot be verified safely.
      throw new Error('unverifiable native configuration path');
    }
    if (raw === null) return false;
    const config = (client === 'codex' ? parseToml(raw) : JSON.parse(raw)) as Record<string, any>;
    const servers = config[client === 'codex' ? 'mcp_servers' : client === 'opencode' ? 'mcp' : 'mcpServers'];
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    namedEntries = ['heddle', 'heddle-comms'].some((name) => Object.hasOwn(servers, name));
    const expected = serverDefinitions(cwd, client);
    const owned = ['heddle', 'heddle-comms'].every((name) => {
      const actual = servers[name];
      const definition = expected[name];
      if (!actual || typeof actual !== 'object') return false;
      const command = client === 'opencode' ? actual.command?.[0] : actual.command;
      const args = client === 'opencode' && Array.isArray(actual.command) ? actual.command.slice(1) : actual.args;
      return command === definition.command && Array.isArray(args)
        && args.length === definition.args.length
        && JSON.stringify(args.slice(0, -1)) === JSON.stringify(definition.args.slice(0, -1))
        && typeof args.at(-1) === 'string'
        && realpathSync(args.at(-1)) === realpathSync(cwd);
    });
    if (owned) {
      // Completed-worker stamps without our ownership record must never become a new baseline.
      if (refuseUnverified && hasNativeWorkerContext(servers) && !existsSync(sidecarPath(path))) {
        throw new Error('stale native worker identity without an ownership sidecar');
      }
      return true;
    }
  } catch { /* Unreadable or unrelated configuration is not an initialized native integration. */ }
  if (namedEntries && refuseUnverified) throw new Error(
    `unverified Heddle MCP entries in ${path} — refusing a native worker that could inherit an orchestrator identity; ` +
    'run from the Heddle installation referenced by these entries or repair the configuration',
  );
  return false;
}

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
    const def = Object.hasOwn(CODEX_MCP_DEFS, n) ? CODEX_MCP_DEFS[n] : undefined;
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
    const s = Object.hasOwn(WORKER_MCP_SERVERS, n) ? WORKER_MCP_SERVERS[n] : undefined;
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
 * Can this provider attach the SPECIFIC worker-MCP servers requested? DERIVED from validateWorkerMcp
 * (not a parallel check) so the two can never drift (gitar #67) — it runs the real attachment gate on
 * the actual list and reports whether it's accepted. Validating the requested servers (not a generic
 * memtrace probe) matters: `['serena']` on cursor is unattachable even though cursor attaches memtrace
 * (cubic #73). Used by the routing CI invariant (routing.test.ts) and the reviewer-pick skip
 * (dispatch.ts): every provider a capability-carrying class can resolve to — primary, fallback, AND
 * every reviewer_pool entry — must attach that class's mcp, so an mcp class can never route to a
 * target that would hard-fail the dispatch. HED-249 replaced HED-205's runtime graceful-degrade
 * (silently dropping mcp for a gemini target) with this config-time guard: refuse loudly, not degrade.
 */
export function mcpAttachable(provider: string, servers: string[]): boolean {
  if (servers.length === 0) return true; // nothing to attach → any provider is fine
  try {
    validateWorkerMcp(provider, servers);
    return true;
  } catch {
    return false;
  }
}

/** A web-research route is satisfied intrinsically by Gemini grounding, or by a provider that can
 * enforce an explicit browse grant. Providers that cannot enforce browse never count as web-capable.
 * Own-property lookup on ENFORCEABLE (same guard as decideCapabilities): a provider name that shadows
 * an inherited Object.prototype member (e.g. "toString") must read as NOT enforceable, never as that
 * member (cubic #63 was this exact landmine on this exact table). */
export function webCapable(provider: string, grantedCapabilities: string[]): boolean {
  const enforceable = Object.hasOwn(ENFORCEABLE, provider) ? ENFORCEABLE[provider] : []; // own-property: a `toString` etc. isn't the prototype method (cubic #63); Object.hasOwn matches routing.ts (codacy #76)
  return provider === 'gemini' || provider === 'gemini-cli'
    || (grantedCapabilities.includes('browse') && enforceable.includes('browse'));
}

/** Provider-level attachability probe (the canonical `memtrace` server) — the drift-guard anchor and
 *  the "does this provider attach worker MCP at all" question. For a SPECIFIC declared list, use
 *  mcpAttachable directly (`['serena']` on cursor is unattachable even though memtrace is — cubic #73). */
export function workerMcpSupported(provider: string): boolean {
  return mcpAttachable(provider, ['memtrace']);
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
  if (provider === 'gemini-cli' || provider === 'opencode') { resolveMcpServers(serverNames); return; }
  if (provider === 'gemini') {
    throw new Error(
      'worker MCP attachment for the gemini provider (agy/Antigravity CLI) is not implemented yet: the ' +
      '.agents/mcp_config.json schema has not been verified against Antigravity docs, and heddle does ' +
      'not write guessed config. Dispatch without --mcp for gemini, or use a codex/cursor worker.',
    );
  }
  if (provider === 'groq' || provider === 'cerebras' || provider === 'openrouter' || provider === 'glm') {
    throw new Error(`worker MCP attachment is not supported for HTTP OpenAI-compat provider "${provider}"`);
  }
  // Any OTHER provider has no worker-MCP attachment path — throw rather than fall through to a pass
  // (and materializeWorkerMcp's default no-op), so a class-default mcp on it is DROPPED, not kept-but-
  // never-attached (qodo/cubic #67). resolveRoute rejects unknown providers upstream; this keeps the
  // gate correct in isolation and makes workerMcpSupported (which probes it) right for them too.
  throw new Error(`worker MCP attachment is not supported for provider "${provider}" (supported: codex, claude, cursor, gemini-cli, opencode)`);
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
 * - gemini-cli: project `.gemini/settings.json` (mcpServers key).
 * - opencode: project `opencode.json` (mcp key; local command arrays).
 * - gemini/agy: project `.agents/mcp_config.json` is still unverified, so this path throws rather
 *   than write a guessed schema.
 */
export function materializeWorkerMcp(
  cwd: string, provider: string, serverNames: string[], opts: MaterializeOpts,
  nativeWorkerEnv?: Record<string, string>,
): () => void {
  const nativeClient = nativeWorkerEnv && nativeClientIntegrationInstalled(cwd, provider, true)
    ? NATIVE_CLIENT_BY_PROVIDER[provider]
    : undefined;
  if (serverNames.length === 0 && !nativeClient) return () => { /* nothing to attach */ };

  // Codex servers and their tool approval come from codexMcpFlags inline `-c` overrides (including
  // default_tools_approval_mode="approve"), so there is nothing to materialize here. Codex server
  // validation happens via codexMcpFlags (called by validateWorkerMcp), not in this function.
  // codex + claude write nothing into the worktree — codex via inline `-c` flags (codexMcpFlags),
  // claude via a temp `--mcp-config` file (claudeMcpConfigFile). Both are no-ops here; claude is
  // never actually routed through this fn (dispatch handles it separately), but returning a no-op
  // keeps it consistent with validateWorkerMcp, which lists claude as supported (codacy #68).
  if (provider === 'codex' || provider === 'claude') return () => { /* no-op */ };

  const servers = resolveMcpServers(serverNames);
  const nativeServers = nativeClient
    ? serverDefinitions(cwd, nativeClient, undefined, nativeWorkerEnv)
    : {};
  const allServers = { ...servers, ...nativeServers };
  switch (provider) {
    case 'cursor':
      return writeMergedMcpJson(join(cwd, '.cursor', 'mcp.json'), allServers, opts);
    case 'gemini-cli':
      return writeMergedMcpJson(join(cwd, '.gemini', 'settings.json'), allServers, opts);
    case 'opencode': {
      if (existsSync(join(cwd, 'opencode.jsonc'))) {
        throw new Error('opencode.jsonc exists; heddle cannot safely materialize a competing opencode.json worker MCP config');
      }
      const definitions = Object.fromEntries(Object.entries(allServers).map(([name, def]) => [name, {
        type: 'local', command: [def.command, ...def.args],
        ...('env' in def && def.env ? { environment: def.env } : {}),
        enabled: true,
        ...(nativeServers[name] ? { timeout: 660_000 }
          : 'timeout' in def && typeof def.timeout === 'number' ? { timeout: def.timeout } : {}),
      }]));
      return writeMergedMcpJson(join(cwd, 'opencode.json'), allServers, opts, 'mcp', definitions);
    }
    case 'gemini':
      throw new Error(
        'worker MCP attachment for the gemini provider (agy/Antigravity CLI) is not implemented yet: the ' +
        '.agents/mcp_config.json schema has not been verified against Antigravity docs, and heddle does ' +
        'not write guessed config. Dispatch without --mcp for gemini, or use a codex/cursor worker.',
      );
    default:
      // No attachment path — throw rather than a silent no-op that keeps mcp in the list but never
      // attaches it (qodo/cubic #67). validateWorkerMcp rejects this first in the dispatch flow.
      throw new Error(`worker MCP attachment is not supported for provider "${provider}" (supported: codex, claude, cursor, gemini-cli, opencode)`);
  }
}

/**
 * The sidecar that makes a JSON config concurrency-safe (JSON carries no comment markers, so the
 * AGENTS.md per-block trick does not transfer — HED-56). It records the PRE-heddle file content
 * once (`original`, captured by the first attaching dispatch) and one server list + definition map
 * per live dispatch. Definitions are per-ref because each native worker has its own child identity.
 * Every mutation rebuilds the merged file from original + all live refs, so the
 * merged view is order-independent; the LAST ref out restores the original bytes (or deletes a
 * file heddle created) and removes the sidecar. Dead refs (crashed dispatches, per the liveness
 * oracle) are dropped on the next mutation.
 */
interface McpSidecar {
  original: string | null;
  refs: Record<string, string[]>;
  /** Definitions are per dispatch because native worker identity/address is per dispatch. */
  definitions: Record<string, Record<string, unknown>>;
}

function sidecarPath(path: string): string {
  return join(dirname(path), '.heddle-mcp-refs.json');
}

/** Missing sidecar → null (fresh state). A CORRUPT sidecar is different: treating it as missing
 *  would silently drop other live dispatches' refs — it is preserved under a .corrupt-<ts> name
 *  (never deleted) and surfaced, and the caller starts fresh from the current file. */
function readSidecar(path: string, required = false): McpSidecar | null {
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
      const definitions: Record<string, Record<string, unknown>> = {};
      if (raw.definitions && typeof raw.definitions === 'object' && !Array.isArray(raw.definitions)) {
        for (const [id, value] of Object.entries(raw.definitions)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            definitions[id] = value as Record<string, unknown>;
          }
        }
      }
      return { original: typeof raw.original === 'string' ? raw.original : null, refs, definitions };
    }
    throw new Error('unexpected shape');
  } catch (err) {
    if (required) throw new Error(`native MCP ownership sidecar ${sc} is unreadable — refusing to replace an unknown active identity`);
    const quarantine = `${sc}.corrupt-${Date.now()}`;
    try { renameSync(sc, quarantine); } catch { /* even the rename failed — leave it */ }
    process.stderr.write(`heddle: MCP sidecar ${sc} was unreadable (${err instanceof Error ? err.message : String(err)}) — preserved as ${quarantine}; starting fresh\n`);
    return null;
  }
}

function mergedContent(
  sidecar: McpSidecar, configKey: string,
  definitions: Record<string, unknown>,
): string {
  const base = sidecar.original !== null
    ? (JSON.parse(sidecar.original) as Record<string, unknown>)
    : {};
  const existing = base[configKey];
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`${configKey} must be an object`);
  }
  const merged: Record<string, unknown> = { ...((existing ?? {}) as Record<string, unknown>) };
  for (const [id, list] of Object.entries(sidecar.refs)) {
    for (const name of list) merged[name] = sidecar.definitions[id]?.[name] ?? definitions[name] ?? merged[name];
  }
  // OpenCode adds its schema on startup when absent. Include that deterministic CLI write before
  // runTarget snapshots a read-only worktree; actual subsequent config/file writes stay detectable.
  const schema = configKey === 'mcp' && base.$schema === undefined
    ? { $schema: 'https://opencode.ai/config.json' } : {};
  return JSON.stringify({ ...schema, ...base, [configKey]: merged }, null, 2);
}

function hasNativeWorkerContext(definitions: Record<string, unknown>): boolean {
  return ['heddle', 'heddle-comms'].some((name) => {
    const definition = definitions[name] as { env?: Record<string, unknown>; environment?: Record<string, unknown> } | undefined;
    return definition?.env?.HEDDLE_WORKER === '1' || definition?.environment?.HEDDLE_WORKER === '1';
  });
}

function sameJsonContent(left: string | null, right: string): boolean {
  if (left === right) return true;
  if (left === null) return false;
  try { return isDeepStrictEqual(JSON.parse(left), JSON.parse(right)); }
  catch { return false; }
}

/** Restore generated fields only while they still equal our worker write. */
function restoreMatchingFields(
  actual: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>,
): void {
  for (const [key, expected] of Object.entries(before)) {
    const value = actual[key];
    if ((key === 'env' || key === 'environment') && value && typeof value === 'object' && !Array.isArray(value)
      && expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const original = after[key];
      restoreMatchingFields(value as Record<string, unknown>, expected as Record<string, unknown>,
        original && typeof original === 'object' && !Array.isArray(original) ? original as Record<string, unknown> : {});
      if (!Object.hasOwn(after, key) && Object.keys(value).length === 0) delete actual[key];
      continue;
    }
    if (!isDeepStrictEqual(value, expected)) continue;
    if (Object.hasOwn(after, key)) Object.defineProperty(actual, key, {
      value: after[key], enumerable: true, configurable: true, writable: true,
    });
    else delete actual[key];
  }
}

/** Restore only entries still equal to our write; retain native CLI additions and user edits. */
function restoreUnchangedEntries(
  current: string | null, expected: string, next: string, configKey: string, names: string[],
): string | null {
  if (current === null) return null;
  try {
    const actual = JSON.parse(current), before = JSON.parse(expected), after = JSON.parse(next);
    const entries = actual?.[configKey];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    for (const name of names) {
      const expected = before[configKey]?.[name], original = after[configKey]?.[name];
      if (isDeepStrictEqual(entries[name], expected)) {
        if (Object.hasOwn(after[configKey] ?? {}, name)) Object.defineProperty(entries, name, {
          value: original, enumerable: true, configurable: true, writable: true,
        });
        else delete entries[name];
      } else if (entries[name] && typeof entries[name] === 'object' && !Array.isArray(entries[name])
        && expected && typeof expected === 'object' && !Array.isArray(expected)) {
        restoreMatchingFields(entries[name], expected,
          original && typeof original === 'object' && !Array.isArray(original) ? original : {});
      }
    }
    return JSON.stringify(actual, null, 2);
  } catch { return null; }
}

function writeMergedMcpJson(
  path: string, servers: Record<string, { command: string; args: string[] }>, opts: MaterializeOpts,
  configKey = 'mcpServers', definitions: Record<string, unknown> = servers,
): () => void {
  const ownId = String(opts.dispatchId);
  const nativeContext = hasNativeWorkerContext(definitions);
  const lockOptions = { required: nativeContext };
  const lock = join(dirname(path), '.heddle-mcp.lock');
  // The lock lives inside the config dir — create the dir FIRST or two fresh processes both fail
  // the lock mkdir with ENOENT and race the file unlocked.
  mkdirSync(dirname(path), { recursive: true });

  withFileLock(lock, () => {
    const sidecar = readSidecar(path, nativeContext)
      ?? { original: existsSync(path) ? readFileSync(path, 'utf8') : null, refs: {}, definitions: {} };
    // A malformed pre-existing config must fail BEFORE any state is persisted — writing the
    // sidecar first would leave a half-mutated pair behind the crash.
    if (sidecar.original !== null) {
      try { JSON.parse(sidecar.original); } catch {
        throw new Error(`${path} exists but is not valid JSON — fix or remove it before dispatching a worker with MCP attached`);
      }
    }
    for (const id of Object.keys(sidecar.refs)) {
      if (id !== ownId && opts.isLive && !opts.isLive(id)) {
        delete sidecar.refs[id];
        delete sidecar.definitions[id];
      }
    }
    if (nativeContext) {
      const owner = Object.keys(sidecar.refs).find((id) => id !== ownId && hasNativeWorkerContext(sidecar.definitions[id] ?? {}));
      if (owner) throw new Error(
        `native worker context in ${path} is owned by active dispatch #${owner} — ` +
        'refusing overlapping child identities; retry after that worker finishes or use a separate worktree',
      );
    }
    sidecar.refs[ownId] = Object.keys(servers);
    sidecar.definitions[ownId] = definitions;
    const merged = mergedContent(sidecar, configKey, definitions); // compute BEFORE persisting anything
    writeFileSync(sidecarPath(path), JSON.stringify(sidecar, null, 2), 'utf8');
    writeFileSync(path, merged, 'utf8');
  }, lockOptions);

  return () => {
    withFileLock(lock, () => {
      try {
        const sidecar = readSidecar(path, nativeContext);
        if (!sidecar || !(ownId in sidecar.refs)) return; // nothing of ours recorded — leave it
        // Tamper check: if the file no longer matches what the sidecar says heddle last wrote,
        // someone (the worker, a human) edited it mid-dispatch — NEVER rewrite or delete over
        // their bytes; drop only our ref so the bookkeeping stays truthful.
        const expected = mergedContent(sidecar, configKey, definitions);
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        // OpenCode normalizes JSON formatting on startup. Equivalent JSON still belongs to this
        // materialization; restoring it prevents completed-worker stamps remaining in project config.
        const tampered = nativeContext ? !sameJsonContent(current, expected) : current !== expected;
        delete sidecar.refs[ownId];
        delete sidecar.definitions[ownId];
        if (tampered) {
          if (nativeContext) {
            const restored = restoreUnchangedEntries(current, expected, mergedContent(sidecar, configKey, definitions), configKey, Object.keys(definitions));
            if (restored !== null) writeFileSync(path, restored, 'utf8');
          }
          process.stderr.write(`heddle: ${path} was edited during dispatch #${ownId} — preserving external edits; removed heddle's ref${nativeContext ? ' and restored unchanged owned fields' : ''}\n`);
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
          writeFileSync(path, mergedContent(sidecar, configKey, definitions), 'utf8');
        }
      } catch (err) {
        process.stderr.write(`heddle: MCP restore for dispatch #${ownId} failed (${err instanceof Error ? err.message : String(err)}) — left as is\n`);
      }
    }, lockOptions);
  };
}
