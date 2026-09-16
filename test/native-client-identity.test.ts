import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { ensureBuilt, PROJECT_ROOT } from './helpers/cli.js';

const cases: Array<{ name: string; env: Record<string, string>; expected: string; linked?: boolean; worker?: boolean; unsafeMarker?: boolean }> = [
  { name: 'invalid HEDDLE_AGENT with valid FLEET_AGENT fallback', env: { HEDDLE_AGENT: '#invalid-room', FLEET_AGENT: 'fleet-seat' }, expected: 'fleet-seat' },
  { name: 'invalid environment with a linked worktree file fallback', env: { HEDDLE_AGENT: '#invalid-room', FLEET_AGENT: 'operator', HEDDLE_COMMS_ADDRESS: '@all' }, expected: 'linked-seat', linked: true },
  { name: 'COMMS_ADDRESS-only identity bypasses an unsafe owner marker', env: { HEDDLE_COMMS_ADDRESS: 'comms-seat' }, expected: 'comms-seat', unsafeMarker: true },
  { name: 'worker child and depth scope survive normalization with an unsafe owner marker', env: { HEDDLE_AGENT: '#invalid-room', HEDDLE_COMMS_ADDRESS: 'parent-seat.1', HEDDLE_WORKER: '1', HEDDLE_PARENT: 'parent-seat', HEDDLE_DISPATCH_ID: '71' }, expected: 'parent-seat.1', linked: true, worker: true, unsafeMarker: true },
];

describe('native MCP identity parity', () => {
  const { tempDir } = useTempResources('heddle-native-identity-', { privateWindowsRoot: true });
  it.each(cases)('$name', async ({ env, expected, linked: useLinked, worker, unsafeMarker }) => {
    await ensureBuilt();
    const home = realpathSync.native(tempDir()), canonical = join(home, 'canonical'), linked = join(home, 'linked');
    mkdirSync(canonical);
    const git = (args: string[]) => execFileSync('git', args, { cwd: canonical, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    writeFileSync(join(canonical, '.gitignore'), '.fleet-agent\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    git(['worktree', 'add', '-qb', 'linked', linked]);
    writeFileSync(join(canonical, '.fleet-agent'), 'canonical-seat');
    writeFileSync(join(linked, '.fleet-agent'), 'linked-seat');
    if (unsafeMarker) {
      const marker = join(canonical, '.fleet-agent');
      renameSync(marker, marker + '.preserved');
      if (process.platform === 'win32') mkdirSync(marker);
      else execFileSync('mkfifo', [marker]);
    }
    const peers: Client[] = [];
    const childEnv = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
      HEDDLE_COMMS_DB: join(home, 'private', 'comms.db'), HEDDLE_LEDGER_DB: join(home, 'private', 'ledger.db'), ...env };
    try {
      for (const server of ['heddle', 'heddle-comms']) {
        const peer = new Client({ name: `${server}-identity-test`, version: '1' });
        peers.push(peer);
        await peer.connect(new StdioClientTransport({ command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', join(PROJECT_ROOT, 'dist/client-mcp.js'), server, canonical],
          env: childEnv, cwd: useLinked ? linked : canonical, stderr: 'pipe' }), { timeout: 10000 });
      }
      const call = async (peer: Client, name: string, args: Record<string, unknown> = {}) => {
        try {
          const result = await peer.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
          expect(result.isError, result.content[0]?.text).not.toBe(true);
          return JSON.parse(result.content[0].text);
        } catch (error) { throw new Error(`${name} failed: ${String(error)}`); }
      };
      const status = await call(peers[0], 'check_workers');
      const comms = await call(peers[1], 'comms_whoami');
      expect(status.identity.agent).toBe(expected);
      expect(status.identity.agent).toBe(comms.identity);
      if (worker) {
        expect(status.identity.worker).toEqual({ parent: 'parent-seat', dispatchId: 71 });
        expect(comms.worker).toBe(true);
        expect(await call(peers[0], 'dispatch_worker', { prompt: 'Never execute nested work', provider: 'codex', model: 'test',
          override_reason: 'Synthetic regression verifies worker depth.' })).toMatchObject({ ok: false, refusal: { code: 'depth-1' } });
      } else expect(status.identity.worker).toBeNull();
      if (useLinked && !worker) expect(comms.bindingSource).toBe('fleet-file');
    } catch (error) { throw new Error(`native identity parity failed: ${String(error)}`); }
    finally { await Promise.all(peers.map((peer) => peer.close().catch(() => undefined))); }
  });
});
