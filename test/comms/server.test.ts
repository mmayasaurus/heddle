import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCommsServer, initOperatorToken, operatorTokenMatches, resolveCommsIdentity, type CommsServer } from '../../src/comms/server.js';
import { CommsLog } from '../../src/comms/log.js';

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

  const baseEnv = () => ({ HEDDLE_COMMS_DB: dbPath, HEDDLE_LEDGER_DB: join(dir, 'no-such-ledger.db') });
  const initToken = (opts: { rotate?: boolean } = {}) => initOperatorToken({ ...opts, path: tokenPath });

  async function connect(env: Record<string, string>) {
    const server = createCommsServer({ env: { ...baseEnv(), ...env }, cwd: dir, warn: (m) => warnings.push(m), operatorTokenPath: tokenPath });
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
    const refused = await call(wrong.client, 'post_message', { to: '#fleet', body: 'I am Maya' });
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
