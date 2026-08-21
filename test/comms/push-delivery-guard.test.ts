import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCommsServer, type CommsServer } from '../../src/comms/server.js';
import { CommsLog } from '../../src/comms/log.js';

describe('regression PR#270 — push delivery loud-fail guard', () => {
  const servers: CommsServer[] = [];
  const clients: Client[] = [];
  const dirs: string[] = [];

  async function connect(push: string, channelLoadedProbe: () => boolean | null) {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-push-delivery-guard-'));
    dirs.push(dir);
    const log = new CommsLog(join(dir, 'comms.db'));
    const warnings: string[] = [];
    const server = createCommsServer({
      env: { HEDDLE_AGENT: 'R', HEDDLE_COMMS_PUSH: push, HEDDLE_LEDGER_DB: join(dir, 'no-such-ledger.db') },
      cwd: dir,
      log,
      warn: (message) => warnings.push(message),
      channelLoadedProbe,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await server.start(serverSide);
    await client.connect(clientSide);
    servers.push(server);
    clients.push(client);
    return { client, log, warnings };
  }

  async function whoami(client: Client): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: 'comms_whoami', arguments: {} }) as { content: { text: string }[] };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    for (const server of servers.splice(0)) await server.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('warns, self-notes once, and retains live push presence when the channel probe is false', async () => {
    const { client, log, warnings } = await connect('1', () => false);

    expect((await whoami(client)).pushDelivery).toBe('suspect-channel-not-loaded');
    expect(warnings).toEqual([expect.stringContaining('was launched WITHOUT --dangerously-load-development-channels server:heddle-comms')]);
    expect(log.transcript({ pair: ['R', 'R'] })).toMatchObject([
      { from: 'R', to: 'R', meta: { diagnostic: 'push-suspect' } },
    ]);
    expect(log.transcript({ pair: ['R', 'R'] })).toHaveLength(1);
    expect(log.liveSession('R')).toMatchObject({ address: 'R' });
  });

  it('leaves push delivery ok without a warning or self-note when the channel probe is true or unknown', async () => {
    for (const channelLoadedProbe of [() => true, () => null] as const) {
      const { client, log, warnings } = await connect('1', channelLoadedProbe);
      expect((await whoami(client)).pushDelivery).toBe('ok');
      expect(warnings).toEqual([]);
      expect(log.transcript({ pair: ['R', 'R'] })).toEqual([]);
    }
  });

  it('reports push delivery off when push is disabled', async () => {
    const { client } = await connect('0', () => false);
    expect((await whoami(client)).pushDelivery).toBe('off');
  });
});
