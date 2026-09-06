import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCommsServer, initOperatorToken, operatorTokenMatches, resolveCommsIdentity, resolveFleetIdentity, type CommsServer } from '../../src/comms/server.js';
import { CommsLog } from '../../src/comms/log.js';

/**
 * `resolveFleetIdentity` walks UP from the cwd it is given to the filesystem root, so a fresh
 * `mkdtemp` under the OS temp dir does NOT isolate it from a stray `.fleet-agent` in an ancestor
 * (…/T, /var/folders, /var, /). Such a file would silently flip every null-identity expectation in
 * this file into a failure. Assert the precondition in SETUP instead, so a polluted machine reports a
 * broken ENVIRONMENT — naming the offending path — rather than a mystifying assertion diff.
 */
function assertNoAncestralFleetAgent(start: string): void {
  let dir = start; // mirrors the prod walk in resolveFleetIdentity, including its root termination
  for (;;) {
    const f = join(dir, '.fleet-agent');
    if (existsSync(f)) {
      throw new Error(
        `polluted test environment: ${f} exists, and resolveFleetIdentity's upward walk from ${start} would bind it. `
        + 'The null-identity cases in this file cannot be hermetic while it is there — remove it and re-run.',
      );
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

/**
 * The channel MCP server in-process (InMemoryTransport — the SDK's documented way to test a
 * server), against TEMP files. Focus: how the OPERATOR identity binds (a configuration-level
 * token, never an env identity var), that a rotation bites immediately, and that the token
 * value never leaks into the log, the deliveries, tool outputs or warnings.
 */
describe('heddle-comms server (in-process)', () => {
  let dir: string;
  let dbPath: string;
  let tokenPath: string;
  const warnings: string[] = [];
  const servers: CommsServer[] = [];
  const clients: Client[] = [];

  const baseEnv = () => ({
    HEDDLE_COMMS_DB: dbPath,
    HEDDLE_LEDGER_DB: join(dir, 'no-such-ledger.db'),
    HEDDLE_PID_BRIDGE_PARENT_START_MS: String(Date.now() - 60_000),
  });
  const initToken = (opts: { rotate?: boolean } = {}) => initOperatorToken({ ...opts, path: tokenPath });

  async function connect(env: Record<string, string>, extra: Partial<Parameters<typeof createCommsServer>[0]> = {}) {
    const server = createCommsServer({ env: { ...baseEnv(), ...env }, cwd: dir, warn: (m) => warnings.push(m), operatorTokenPath: tokenPath, ...extra });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await server.start(serverSide);
    await client.connect(clientSide);
    servers.push(server); clients.push(client);
    return { server, client };
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0].text;
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    return { text, parsed, isError: r.isError === true };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-server-test-'));
    assertNoAncestralFleetAgent(dir);
    dbPath = join(dir, 'comms.db');
    tokenPath = join(dir, 'operator.token');
    warnings.length = 0;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    for (const s of servers.splice(0)) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds an agent from HEDDLE_AGENT, refuses "operator" from the agent sources, and starts unbound otherwise', () => {
    const w: string[] = [];
    expect(resolveCommsIdentity({ ...baseEnv(), HEDDLE_AGENT: 'V' }, dir, (m) => w.push(m), tokenPath)).toEqual({ identity: 'V', isOperator: false });
    expect(resolveCommsIdentity({ ...baseEnv(), FLEET_AGENT: 'K.2' }, dir, (m) => w.push(m), tokenPath)).toEqual({ identity: 'K.2', isOperator: false });
    expect(resolveCommsIdentity({ ...baseEnv(), HEDDLE_AGENT: 'operator' }, dir, (m) => w.push(m), tokenPath)).toEqual({ identity: null, isOperator: false });
    expect(w.some((m) => m.includes('refusing to bind the operator identity'))).toBe(true);
    expect(resolveCommsIdentity({ ...baseEnv() }, dir, (m) => w.push(m), tokenPath)).toEqual({ identity: null, isOperator: false });
  });

  describe('regression PR#387 — late Claude identity binding', () => {
    const bridgePath = (cacheDir: string) => join(cacheDir, `pid-${process.ppid}.label`);

    it('binds the same unbound server on its next sender-requiring tool call after the PID bridge appears', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      const unbound = await call(session.client, 'post_message', { to: '#fleet', body: 'before rename' });
      expect(unbound.isError).toBe(true);
      expect(unbound.text).toMatch(/no bound comms identity/);

      writeFileSync(bridgePath(cacheDir), 'V\n');
      const bound = await call(session.client, 'post_message', { to: '#fleet', body: 'after rename' });
      expect(bound.parsed).toMatchObject({ outcome: 'logged' });
      expect(bound.text).toContain('from V to #fleet');
      expect(session.server.identity).toBe('V');
    });

    it('restores and PUMPS a persisted held message after a lazily-bound restart', async () => {
      // r3 (ledger 619): the pump must do REAL work for a lazy session — a held delivery persisted
      // by a previous run is restored at lazy bind and released once the target unblocks.
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const states = new Map([['V.1', 'permission-gate']]);
      const targetState = { state: (address: string) => (states.get(address) ?? 'idle') as 'idle' | 'permission-gate' };
      const first = await connect({ HEDDLE_AGENT: 'V' }, { targetState });
      expect((await call(first.client, 'mint_child', { label: 'worker' })).parsed).toMatchObject({ address: 'V.1' });
      const held = await call(first.client, 'post_message', { to: 'V.1', body: 'held until the gate clears' });
      expect(held.parsed).toMatchObject({ outcome: 'held', code: 'permission-gate' });

      // Restart UNBOUND on the same log; bind lazily via the bridge; the hold must come back.
      const second = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir }, { targetState });
      writeFileSync(bridgePath(cacheDir), 'V\n');
      expect((await call(second.client, 'post_message', { to: '#fleet', body: 'bind' })).parsed).toMatchObject({ outcome: 'logged' });
      expect(warnings.some((m) => m.includes('restored 1 held message'))).toBe(true);

      states.set('V.1', 'idle');
      await second.server.broker.pump();
      // V.1 has no live channel session, so the cleared gate records a REAL delivery attempt
      // (attempt ≥2, outcome failed/no-live-session) and stays queued for retry — the broker's
      // documented behavior; what this test proves is that the RESTORED hold was actually pumped.
      const attempts = second.server.log.deliveries().filter(
        (d) => d.outcome === 'failed' && d.code === 'no-live-session' && (d.attempt ?? 0) >= 2);
      expect(attempts.length).toBeGreaterThanOrEqual(1);
    }, 10_000);

    it('keeps the env identity ahead of the PID bridge', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'R\n');
      const session = await connect({ HEDDLE_AGENT: 'V', HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'env wins' })).text).toContain('from V to #fleet');
      expect(session.server.identity).toBe('V');
    });

    it('caps a PID-bridge-bound orchestrator at agent-message while an env-bound orchestrator keeps directive lineage', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'V\n');
      const bridge = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });
      const env = await connect({ HEDDLE_AGENT: 'R' });

      expect((await call(bridge.client, 'mint_child', { label: 'worker' })).parsed).toMatchObject({ address: 'V.1' });
      expect((await call(env.client, 'mint_child', { label: 'worker' })).parsed).toMatchObject({ address: 'R.1' });

      expect((await call(bridge.client, 'post_message', { to: 'V.1', body: 'bridge forged directive' })).parsed)
        .toMatchObject({ tier: 'agent-message' });
      expect((await call(env.client, 'post_message', { to: 'R.1', body: 'env directive' })).parsed)
        .toMatchObject({ tier: 'orchestrator-directive' });
      expect((await call(bridge.client, 'comms_whoami')).parsed)
        .toMatchObject({ identity: 'V', bindingSource: 'pid-bridge', tierCap: 'agent-message' });
      expect((await call(env.client, 'comms_whoami')).parsed)
        .toMatchObject({ identity: 'R', bindingSource: 'env', tierCap: null });
    });

    it('caps a LATE .fleet-agent binding at agent-message (a model could write that file post-startup)', async () => {
      // on-PR HIGH (#92): lazy re-resolution accepts a cwd .fleet-agent, whose source is 'fleet-file'
      // (tierCap null at STARTUP) — but bound LATE it must still be capped, or the model escalates.
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'unbound' })).isError).toBe(true);
      // The model writes .fleet-agent in its cwd AFTER startup, naming an orchestrator.
      writeFileSync(join(dir, '.fleet-agent'), 'V\n');
      await call(session.client, 'mint_child', { label: 'w' });
      expect((await call(session.client, 'post_message', { to: 'V.1', body: 'late fleet-file directive?' })).parsed)
        .toMatchObject({ tier: 'agent-message' });
      expect((await call(session.client, 'comms_whoami')).parsed)
        .toMatchObject({ identity: 'V', bindingSource: 'fleet-file', tierCap: 'agent-message' });
      rmSync(join(dir, '.fleet-agent'));
    });

    it('comms_whoami reports the identity immediately after a lazy rename bind', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });
      expect((await call(session.client, 'comms_whoami')).parsed).toMatchObject({ identity: null });
      writeFileSync(bridgePath(cacheDir), 'V\n');
      // whoami itself must resolve the pending bind — no other sender-requiring call first.
      expect((await call(session.client, 'comms_whoami')).parsed)
        .toMatchObject({ identity: 'V', bindingSource: 'pid-bridge', tierCap: 'agent-message' });
    });

    it('does not bind a worker from the PID bridge', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'V\n');
      const session = await connect({ HEDDLE_WORKER: '1', HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      const result = await call(session.client, 'post_message', { to: '#fleet', body: 'worker bridge' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/no bound comms identity/);
      expect((await call(session.client, 'comms_whoami')).parsed).toMatchObject({ identity: null, bindingSource: null, tierCap: null });
    });

    it('refuses symlinked and oversized PID bridge labels with one warning', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const outside = join(dir, 'outside-label');
      writeFileSync(outside, 'V\n');
      symlinkSync(outside, bridgePath(cacheDir));
      const symlinked = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });
      expect((await call(symlinked.client, 'post_message', { to: '#fleet', body: 'symlink label' })).isError).toBe(true);
      expect((await call(symlinked.client, 'post_message', { to: '#fleet', body: 'symlink retry' })).isError).toBe(true);
      expect(warnings.filter((m) => m.includes('must be a regular file')).length).toBe(1);

      rmSync(bridgePath(cacheDir));
      writeFileSync(bridgePath(cacheDir), 'V'.repeat(257));
      const oversized = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });
      expect((await call(oversized.client, 'post_message', { to: '#fleet', body: 'oversized label' })).isError).toBe(true);
      expect((await call(oversized.client, 'post_message', { to: '#fleet', body: 'oversized retry' })).isError).toBe(true);
      expect(warnings.filter((m) => m.includes('exceeds 256 bytes')).length).toBe(1);
    });

    it('ignores a bridge file that predates the host process (recycled-pid guard)', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'V\n');
      const past = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      utimesSync(bridgePath(cacheDir), past, past);
      const session = await connect({
        HEDDLE_IDENTITY_CACHE_DIR: cacheDir,
        HEDDLE_PID_BRIDGE_PARENT_START_MS: String(Date.now() - 60_000),
      });
      const result = await call(session.client, 'post_message', { to: '#fleet', body: 'stale label' });
      expect(result.isError).toBe(true);
      expect(warnings.some((m) => m.includes('recycled pid'))).toBe(true);
      expect(session.server.identity).toBeNull();
    });

    it('accepts a bridge file written after the host process started', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'V\n');
      const session = await connect({
        HEDDLE_IDENTITY_CACHE_DIR: cacheDir,
        HEDDLE_PID_BRIDGE_PARENT_START_MS: String(Date.now() - 3600_000),
      });
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'fresh label' })).text).toContain('from V to #fleet');
    });

    it('refuses an operator PID bridge label and stays unbound', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'operator\n');
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      const result = await call(session.client, 'post_message', { to: '#fleet', body: 'not operator' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/no bound comms identity/);
      expect(session.server.identity).toBeNull();
    });

    it('pins a PID-bridge identity after binding even if the label file later changes', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      writeFileSync(bridgePath(cacheDir), 'V\n');
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'first label' })).text).toContain('from V to #fleet');
      writeFileSync(bridgePath(cacheDir), 'R\n');
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'second label' })).text).toContain('from V to #fleet');
      expect(session.server.identity).toBe('V');
      expect(warnings.filter((m) => m.includes('identity changed after binding')).length).toBe(1);
    });

    it('does one post-pin divergence check, then no longer reads the PID bridge', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      writeFileSync(bridgePath(cacheDir), 'V\n');
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'bind' })).text).toContain('from V to #fleet');
      writeFileSync(bridgePath(cacheDir), 'R\n');
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'divergence check' })).text).toContain('from V to #fleet');
      rmSync(cacheDir, { recursive: true, force: true });
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'no more bridge reads' })).text).toContain('from V to #fleet');
      expect(warnings.some((m) => m.includes('cache is not a directory'))).toBe(false);
    });

    it('latches the post-pin check when the PID bridge disappears', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      const session = await connect({ HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      writeFileSync(bridgePath(cacheDir), 'V\n');
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'bind' })).text).toContain('from V to #fleet');
      rmSync(bridgePath(cacheDir));
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'bridge absent' })).text).toContain('from V to #fleet');
      writeFileSync(bridgePath(cacheDir), 'R\n');
      // Third post stays within the broker's burst limit (3/1s) and fully proves the latch: the
      // single post-pin check was consumed by the bridge-absent call, so this divergent file is
      // never even read — no rebind, no divergence warning.
      expect((await call(session.client, 'post_message', { to: '#fleet', body: 'still pinned' })).text).toContain('from V to #fleet');
      expect(warnings.some((m) => m.includes('identity changed after binding'))).toBe(false);
    });

    it('never rebinds a startup-bound HEDDLE_AGENT session even when a PID bridge names another agent', async () => {
      const cacheDir = join(dir, 'identity-cache');
      mkdirSync(cacheDir);
      writeFileSync(bridgePath(cacheDir), 'R\n');
      const session = await connect({ HEDDLE_AGENT: 'V', HEDDLE_IDENTITY_CACHE_DIR: cacheDir });

      expect(session.server.identity).toBe('V');
      for (const body of ['startup bound', 'still pinned', 'still V']) {
        expect((await call(session.client, 'post_message', { to: '#fleet', body })).text).toContain('from V to #fleet');
      }
      expect(warnings.some((m) => m.includes('identity changed after binding'))).toBe(false);
    });
  });

  it('post_message records meta.important for an ⭐-tagged message, absent otherwise (HED-328)', async () => {
    const { client } = await connect({ HEDDLE_AGENT: 'V' });
    const idOf = (r: { parsed: unknown }) => (r.parsed as { messageId: number }).messageId;
    const flagged = idOf(await call(client, 'post_message', { to: '#fleet', body: 'urgent', important: true }));
    const plain = idOf(await call(client, 'post_message', { to: '#fleet', body: 'normal' }));
    const db = new DatabaseSync(dbPath);
    try {
      const metaOf = (id: number) =>
        JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?').get(id) as { meta: string }).meta) as Record<string, unknown>;
      expect(metaOf(flagged).important).toBe(true);       // the flag persists for the collector (328b) to read
      expect(metaOf(plain).important).toBeUndefined();     // a normal post is never marked important
    } finally {
      db.close();
    }
  });

  // ── HED-187: the RAW fleet identity, extracted so the rotator can see through the operator binding ──

  it('resolveFleetIdentity: the raw chain (HEDDLE_AGENT → FLEET_AGENT → HEDDLE_COMMS_ADDRESS → .fleet-agent → null)', () => {
    const w: string[] = [];
    const warn = (m: string) => w.push(m);
    expect(resolveFleetIdentity({ ...baseEnv(), HEDDLE_AGENT: 'V' }, dir, warn)).toBe('V');
    expect(resolveFleetIdentity({ ...baseEnv(), FLEET_AGENT: 'K.2' }, dir, warn)).toBe('K.2');
    expect(resolveFleetIdentity({ ...baseEnv(), HEDDLE_COMMS_ADDRESS: 'R.1' }, dir, warn)).toBe('R.1');
    // Precedence, not merely presence: HEDDLE_AGENT wins over the two later sources.
    expect(resolveFleetIdentity({ ...baseEnv(), HEDDLE_AGENT: 'V', FLEET_AGENT: 'K', HEDDLE_COMMS_ADDRESS: 'R.1' }, dir, warn)).toBe('V');
    // 'operator' is refused from these sources here too (same warning as resolveCommsIdentity).
    expect(resolveFleetIdentity({ ...baseEnv(), HEDDLE_AGENT: 'operator' }, dir, warn)).toBeNull();
    expect(w.some((m) => m.includes('refusing to bind the operator identity'))).toBe(true);
    // No env, no file: the upward walk terminates at the filesystem root with null (never hangs).
    // Hermetic only because beforeEach proved no `.fleet-agent` sits anywhere above `dir`.
    expect(resolveFleetIdentity({ ...baseEnv() }, dir, warn)).toBeNull();

    // A `.fleet-agent` file is found by walking UP from cwd, and matches resolveCommsIdentity.
    const deep = join(dir, 'nested', 'deep');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(dir, '.fleet-agent'), 'V\n');
    expect(resolveFleetIdentity({ ...baseEnv() }, deep, warn)).toBe('V');
    expect(resolveCommsIdentity({ ...baseEnv() }, deep, warn, tokenPath)).toEqual({ identity: 'V', isOperator: false });
  });

  it('resolveFleetIdentity ignores a PID bridge unless the caller opts in', () => {
    const cacheDir = join(dir, 'identity-cache');
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, `pid-${process.ppid}.label`), 'V\n');
    const env = { ...baseEnv(), HEDDLE_IDENTITY_CACHE_DIR: cacheDir };
    expect(resolveFleetIdentity(env, dir, () => undefined)).toBeNull();
    expect(resolveFleetIdentity(env, dir, () => undefined, () => undefined, { allowPidBridge: true })).toBe('V');
  });

  it('resolveFleetIdentity sees the fleet letter THROUGH the operator binding that masks it (the rotator guard)', () => {
    // The masking problem HED-187's in-session guard exists for: a rotator started inside agent V's
    // terminal binds as the operator, so `identity` reads 'operator' and the letter V is invisible.
    // The raw resolution ignores HEDDLE_COMMS_ROLE entirely, so the guard can still see it.
    initToken();
    const token = readFileSync(tokenPath, 'utf8').trim();
    const operatorEnv = { ...baseEnv(), HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token, HEDDLE_AGENT: 'V' };
    expect(resolveCommsIdentity(operatorEnv, dir, () => undefined, tokenPath)).toEqual({ identity: 'operator', isOperator: true });
    expect(resolveFleetIdentity(operatorEnv, dir, () => undefined)).toBe('V');
    // …and via a `.fleet-agent` file, which is how an agent's worktree carries its letter.
    writeFileSync(join(dir, '.fleet-agent'), 'V\n');
    const { HEDDLE_AGENT: _dropped, ...fileOnly } = operatorEnv;
    expect(resolveCommsIdentity(fileOnly, dir, () => undefined, tokenPath)).toEqual({ identity: 'operator', isOperator: true });
    expect(resolveFleetIdentity(fileOnly, dir, () => undefined)).toBe('V');
  });

  it('operator: binds ONLY with the matching token; env-only role is refused; the whole session then posts as operator', async () => {
    const created = initToken();
    expect(created.action).toBe('created');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenPath, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(initToken().action).toBe('kept'); // never overwritten by accident
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token);

    // Role without token → refused (unbound), with a warning; wrong token → refused.
    const noToken = await connect({ HEDDLE_COMMS_ROLE: 'operator' });
    expect(noToken.server.identity).toBeNull();
    expect(warnings.some((m) => m.includes('refusing to bind operator'))).toBe(true);
    const wrong = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: 'deadbeef'.repeat(6) });
    expect(wrong.server.identity).toBeNull();
    const refused = await call(wrong.client, 'post_message', { to: '#fleet', body: 'I am the operator' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/no bound comms identity/);

    // The real token binds the operator; her posts carry the operator tier without membership.
    const op = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token });
    expect(op.server.identity).toBe('operator');
    expect(op.server.isOperator).toBe(true);
    const who = await call(op.client, 'comms_whoami');
    expect(who.parsed).toMatchObject({ identity: 'operator', operator: true });
    const closed = await call(op.client, 'create_room', { name: '#hed-73', topic: 'lane room' });
    expect(closed.parsed).toMatchObject({ room: { name: '#hed-73', open: false, createdBy: 'operator' } });
    const posted = await call(op.client, 'post_message', { to: '#hed-73', body: 'operator speaking' });
    expect(posted.parsed).toMatchObject({ outcome: 'logged', code: 'room-pull', tier: 'operator' });
    const all = await call(op.client, 'post_message', { to: '@all', body: 'stop all workers' });
    expect(all.parsed).toMatchObject({ tier: 'operator' });
    // The operator does not mint children.
    expect((await call(op.client, 'mint_child')).text).toMatch(/operator does not mint/);
    const raw = new DatabaseSync(dbPath);
    try {
      const rows = raw.prepare("SELECT tier, verified FROM messages WHERE sender = 'operator'").all() as { tier: string; verified: number }[];
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.tier === 'operator' && r.verified === 1)).toBe(true);
    } finally { raw.close(); }
  });

  it('a token rotation invalidates a running operator session immediately, and the new token binds', async () => {
    initToken();
    const oldToken = readFileSync(tokenPath, 'utf8').trim();
    const op = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: oldToken });
    expect((await call(op.client, 'post_message', { to: '#fleet', body: 'before rotation' })).parsed).toMatchObject({ tier: 'operator' });

    const rotated = initToken({ rotate: true });
    expect(rotated.action).toBe('rotated');
    const newToken = readFileSync(tokenPath, 'utf8').trim();
    expect(newToken).not.toBe(oldToken);
    expect(operatorTokenMatches({ ...baseEnv(), HEDDLE_COMMS_OPERATOR_TOKEN: oldToken }, tokenPath)).toBe(false);
    expect(operatorTokenMatches({ ...baseEnv(), HEDDLE_COMMS_OPERATOR_TOKEN: newToken }, tokenPath)).toBe(true);

    // The already-running session with the OLD token can no longer act as operator.
    const after = await call(op.client, 'post_message', { to: '#fleet', body: 'after rotation' });
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/operator token no longer matches/);
    // …its whoami says revoked, and a push-mode operator session loses its presence row + stops pumping.
    expect((await call(op.client, 'comms_whoami')).parsed).toMatchObject({ identity: null, revoked: true, operator: false });
    // A session configured with the new token binds.
    const fresh = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: newToken });
    expect(fresh.server.identity).toBe('operator');
  });

  it('a rotated push-mode operator session drops its presence and stops receiving channel events', async () => {
    initToken();
    const token = readFileSync(tokenPath, 'utf8').trim();
    const events: unknown[] = [];
    const push = createCommsServer({ env: { ...baseEnv(), HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token, HEDDLE_COMMS_PUSH: '1' }, cwd: dir, warn: (m) => warnings.push(m), operatorTokenPath: tokenPath });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    client.fallbackNotificationHandler = async (n) => { events.push(n); };
    await push.start(serverSide); await client.connect(clientSide);
    servers.push(push); clients.push(client);
    expect(new CommsLog(dbPath).liveSession('operator')).not.toBeNull();
    initToken({ rotate: true });
    const probe = new CommsLog(dbPath);
    probe.append({ from: 'K', to: 'operator', body: 'after rotation' });
    probe.close();
    await new Promise((r) => setTimeout(r, 1300)); // one loop cycle
    expect(events).toEqual([]);                    // nothing pushed to the revoked session
    expect(new CommsLog(dbPath).liveSession('operator')).toBeNull(); // presence gone
    expect(warnings.some((m) => m.includes('operator credential revoked'))).toBe(true);
  }, 10_000);

  it('workers can never bind operator, even with an inherited operator env; the token path is not env-overridable', () => {
    initToken();
    const token = readFileSync(tokenPath, 'utf8').trim();
    const w: string[] = [];
    // A heddle-dispatched worker that inherited the operator session's env binds as the WORKER, never operator.
    expect(resolveCommsIdentity({ ...baseEnv(), HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token, HEDDLE_WORKER: '1', HEDDLE_COMMS_ADDRESS: 'K.3' }, dir, (m) => w.push(m), tokenPath))
      .toEqual({ identity: 'K.3', isOperator: false });
    expect(w.some((m) => m.includes('workers are never the operator'))).toBe(true);
    // The trust root cannot be moved by env: a process pointing at its own token file does not become operator.
    const rogue = join(dir, 'rogue.token');
    initOperatorToken({ path: rogue });
    const rogueToken = readFileSync(rogue, 'utf8').trim();
    expect(resolveCommsIdentity({ ...baseEnv(), HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: rogueToken, HEDDLE_OPERATOR_TOKEN_PATH: rogue }, dir, () => undefined, tokenPath))
      .toEqual({ identity: null, isOperator: false });
    // Permissions are enforced on rotate and on an existing loose file.
    initToken({ rotate: true });
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    chmodSync(tokenPath, 0o644);
    initToken();
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('the token value never appears in the db, tool outputs, or warnings', async () => {
    initToken();
    const token = readFileSync(tokenPath, 'utf8').trim();
    const op = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token });
    const outputs: string[] = [];
    outputs.push((await call(op.client, 'comms_whoami')).text);
    outputs.push((await call(op.client, 'post_message', { to: '#fleet', body: 'hello' })).text);
    outputs.push((await call(op.client, 'read_transcript', { all: true })).text);
    outputs.push((await call(op.client, 'list_rooms')).text);
    outputs.push((await call(op.client, 'post_message', { to: 'K.1', body: 'x', requested_tier: 'root' })).text); // an error path
    outputs.push((await call(op.client, 'log_sent', { to: '#fleet', body: 'x' })).text); // refused: rooms don't go through log_sent
    const wrong = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token + 'x' });
    outputs.push((await call(wrong.client, 'post_message', { to: '#fleet', body: 'x' })).text);
    for (const out of outputs) expect(out).not.toContain(token);
    for (const w of warnings) expect(w).not.toContain(token);
    const raw = new DatabaseSync(dbPath);
    try {
      for (const table of ['messages', 'deliveries', 'participants', 'sessions', 'rooms']) {
        const rows = raw.prepare(`SELECT * FROM ${table}`).all();
        expect(JSON.stringify(rows)).not.toContain(token);
      }
    } finally { raw.close(); }
    expect(existsSync(tokenPath)).toBe(true); // and the only copy is the file
  });

  it('read_transcript: needs an identity; agents read their rooms / own DMs / inbox; only the operator reads everything', async () => {
    initToken();
    const token = readFileSync(tokenPath, 'utf8').trim();
    const op = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token });
    const k = await connect({ HEDDLE_AGENT: 'K' });
    const unbound = await connect({});
    await call(op.client, 'create_room', { name: '#private' });               // closed, K not a member
    await call(op.client, 'post_message', { to: '#private', body: 'secret' });
    await call(op.client, 'post_message', { to: 'R', body: 'dm to R' });        // a DM K is not part of
    await call(op.client, 'post_message', { to: 'K', body: 'dm to K' });
    await call(k.client, 'post_message', { to: '#fleet', body: 'hello fleet' });
    expect((await call(unbound.client, 'read_transcript', { all: true })).text).toMatch(/no bound comms identity/);
    expect((await call(k.client, 'read_transcript', { all: true })).text).toMatch(/operator-only/);
    expect((await call(k.client, 'read_transcript', { room: '#private' })).text).toMatch(/may not read #private/);
    expect((await call(k.client, 'read_transcript', { pair: ['operator', 'R'] })).text).toMatch(/only read DM threads you are part of/);
    expect(((await call(k.client, 'read_transcript', { pair: ['operator', 'K'] })).parsed as { body: string }[]).map((m) => m.body)).toEqual(['dm to K']);
    expect(((await call(k.client, 'read_transcript', { room: '#fleet' })).parsed as { body: string }[]).map((m) => m.body)).toEqual(['hello fleet']);
    expect(((await call(k.client, 'read_transcript', {})).parsed as { body: string }[]).map((m) => m.body)).toEqual(['dm to K']); // default = own inbox
    expect(((await call(op.client, 'read_transcript', { all: true })).parsed as unknown[]).length).toBe(4);
    expect(((await call(op.client, 'read_transcript', { room: '#private' })).parsed as { body: string }[]).map((m) => m.body)).toEqual(['secret']);
  });

  it('agent session: pull-only by default (no presence row), push mode registers presence + emits channel events', async () => {
    const pullOnly = await connect({ HEDDLE_AGENT: 'K' });
    expect(pullOnly.server.pushEnabled).toBe(false);
    expect(new CommsLog(dbPath).liveSessions().map((s) => s.address)).toEqual([]);
    expect(warnings.some((m) => m.includes('push disabled'))).toBe(true);
    const tools = await pullOnly.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['post_message', 'read_transcript', 'check_inbox', 'mint_child', 'create_room', 'join_room', 'acquire_floor', 'comms_whoami']));

    const events: { method: string; params: { content: string; meta: Record<string, string> } }[] = [];
    const push = createCommsServer({ env: { ...baseEnv(), HEDDLE_AGENT: 'R', HEDDLE_COMMS_PUSH: '1', HEDDLE_SESSION_NAME: 'romeo' }, cwd: dir, warn: (m) => warnings.push(m) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    client.fallbackNotificationHandler = async (n) => { events.push(n as never); };
    await push.start(serverSide);
    await client.connect(clientSide);
    servers.push(push); clients.push(client);
    expect(new CommsLog(dbPath).liveSession('R')).toMatchObject({ address: 'R', sessionName: 'romeo' });

    // K posts to R through its own (pull-only) server: the broker sees R live → queued-for-channel…
    const res = await call(pullOnly.client, 'post_message', { to: 'R', body: 'ping', issue: 'HED-73' });
    expect(res.parsed).toMatchObject({ outcome: 'sent', code: 'queued-for-channel', to: 'R' });
    // …and R's inbound pump pushes it as a structured channel event on its next cycle (≤ 1 s).
    await new Promise((r) => setTimeout(r, 1300));
    expect(events.length).toBe(1);
    expect(events[0].method).toBe('notifications/claude/channel');
    expect(events[0].params.content).toBe('ping');
    expect(events[0].params.meta).toMatchObject({ tier: 'agent-message', sender: 'K', target: 'R', kind: 'chat', verified: '0', issue: 'HED-73' });
    for (const k of Object.keys(events[0].params.meta)) expect(k).toMatch(/^[a-z0-9_]+$/);
    expect(new CommsLog(dbPath).deliveries({ target: 'R' }).map((d) => d.code)).toEqual(['queued-for-channel', 'channel-written']);
  }, 10_000);
});
