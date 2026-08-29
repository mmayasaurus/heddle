import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bootstrapComms } from '../../src/comms/bootstrap.js';
import { CommsLog } from '../../src/comms/log.js';
import { createCommsServer, type CommsServer } from '../../src/comms/server.js';
import { PROJECTS_SCHEMA_VERSION } from '../../src/projects.js';

describe('bootstrapComms', () => {
  let dir: string;
  let heddleDir: string;
  let dbPath: string;
  let tokenPath: string;
  let projectsPath: string;
  const clients: Client[] = [];
  const servers: CommsServer[] = [];

  const options = () => ({ commsDbPath: dbPath, operatorTokenPath: tokenPath, projectsPath });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hed409-'));
    heddleDir = join(dir, 'heddle');
    dbPath = join(heddleDir, 'comms.db');
    tokenPath = join(heddleDir, 'operator.token');
    projectsPath = join(dir, 'projects.json');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    for (const server of servers.splice(0)) await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the database, operator token, and default fleet room', () => {
    const result = bootstrapComms(options());
    const token = readFileSync(tokenPath, 'utf8').trim();

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(heddleDir).mode & 0o777).toBe(0o700);
    const log = new CommsLog(dbPath);
    try {
      expect(log.room('#fleet')).not.toBeNull();
    } finally {
      log.close();
    }
    expect(result.operatorToken.action).toBe('created');
    expect(result.registryError).toBeNull();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(Object.keys(result.operatorToken).sort()).toEqual(['action', 'path']);
  });

  it('keeps the token byte-for-byte unchanged and permissions hardened on a rerun', () => {
    bootstrapComms(options());
    const before = readFileSync(tokenPath);

    const result = bootstrapComms(options());

    expect(result.operatorToken.action).toBe('kept');
    expect(readFileSync(tokenPath)).toEqual(before);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(heddleDir).mode & 0o777).toBe(0o700);
  });

  it('does not re-mode an existing heddle directory while still provisioning comms', () => {
    mkdirSync(heddleDir, { recursive: true });
    chmodSync(heddleDir, 0o755);

    bootstrapComms(options());

    expect(statSync(heddleDir).mode & 0o777).toBe(0o755);
    expect(existsSync(tokenPath)).toBe(true);
    const log = new CommsLog(dbPath);
    try {
      expect(log.room('#fleet')).not.toBeNull();
    } finally {
      log.close();
    }
  });

  it('creates valid registered project rooms and reports invalid room addresses', () => {
    writeFileSync(projectsPath, JSON.stringify({
      schemaVersion: PROJECTS_SCHEMA_VERSION,
      projects: [
        { name: 'valid', workspaceRoots: [dir], agentIds: ['K'], linearTeam: 'HED', defaultRoom: '#myproj', launcher: 'start-valid' },
        { name: 'invalid', workspaceRoots: [dir], agentIds: ['R'], linearTeam: 'HED', defaultRoom: 'myproj', launcher: 'start-invalid' },
      ],
    }));

    const first = bootstrapComms(options());
    const log = new CommsLog(dbPath);
    try {
      expect(log.room('#myproj')).not.toBeNull();
    } finally {
      log.close();
    }
    expect(first.rooms).toContainEqual({ name: '#myproj', created: true });
    expect(first.skippedProjectRooms).toEqual([{ name: 'myproj', reason: 'defaultRoom is not a valid room address' }]);

    const second = bootstrapComms(options());
    expect(second.rooms).toContainEqual({ name: '#myproj', created: false });
  });

  it('reports a pre-existing closed project room instead of silently keeping it', () => {
    // Seed the db with #myproj already CLOSED, before any project registers it.
    const seed = new CommsLog(dbPath);
    try {
      seed.createRoom({ name: '#myproj', by: 'operator', open: false });
    } finally {
      seed.close();
    }
    writeFileSync(projectsPath, JSON.stringify({
      schemaVersion: PROJECTS_SCHEMA_VERSION,
      projects: [
        { name: 'closed', workspaceRoots: [dir], agentIds: ['K'], linearTeam: 'HED', defaultRoom: '#myproj', launcher: 'start-closed' },
      ],
    }));

    const result = bootstrapComms(options());

    expect(result.skippedProjectRooms).toContainEqual({ name: '#myproj', reason: 'room already exists but is closed; left as-is (reopening is broker governance)' });
    expect(result.rooms.map((room) => room.name)).not.toContain('#myproj');
  });

  it('provisions core comms when projects.json is corrupt and reports the skipped registry', () => {
    writeFileSync(projectsPath, '{not valid json');

    const result = bootstrapComms(options());

    expect(result.registryError).toMatch(/projects\.json.*not valid JSON/);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(tokenPath)).toBe(true);
    expect(result.rooms).toEqual([{ name: '#fleet', created: true }]);
    expect(result.skippedProjectRooms).toEqual([]);
    const log = new CommsLog(dbPath);
    try {
      expect(log.room('#fleet')).not.toBeNull();
    } finally {
      log.close();
    }
  });

  it('exchanges a message through the channel-server wrapper against the bootstrapped database', async () => {
    // The packaged entry deliberately has no injectable operator-token path, so test its exact
    // createCommsServer wrapper here to keep the live operator trust root out of the test process.
    // Broker.checkRoom rejects missing rooms, while the server only ensures #fleet, so #myproj
    // proves bootstrap created the project room before either server starts.
    writeFileSync(projectsPath, JSON.stringify({
      schemaVersion: PROJECTS_SCHEMA_VERSION,
      projects: [
        { name: 'exchange', workspaceRoots: [dir], agentIds: ['K'], linearTeam: 'HED', defaultRoom: '#myproj', launcher: 'start-exchange' },
      ],
    }));
    bootstrapComms(options());
    const token = readFileSync(tokenPath, 'utf8').trim();

    const connect = async (env: Record<string, string>) => {
      const server = createCommsServer({
        env: { HEDDLE_COMMS_DB: dbPath, HEDDLE_LEDGER_DB: join(dir, 'ledger.db'), ...env },
        cwd: dir,
        operatorTokenPath: tokenPath,
        warn: () => undefined,
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'bootstrap-test', version: '0' }, { capabilities: {} });
      await server.start(serverSide);
      await client.connect(clientSide);
      servers.push(server);
      clients.push(client);
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
      return JSON.parse(result.content[0].text);
    };

    const operator = await connect({ HEDDLE_COMMS_ROLE: 'operator', HEDDLE_COMMS_OPERATOR_TOKEN: token });
    const agent = await connect({ HEDDLE_AGENT: 'K' });
    await call(operator, 'post_message', { to: '#myproj', body: 'bootstrap exchange' });

    const messages = await call(agent, 'read_transcript', { room: '#myproj' }) as { body: string }[];
    expect(messages.map((message) => message.body)).toContain('bootstrap exchange');
  });
});
