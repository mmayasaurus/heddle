import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyToml } from 'smol-toml';
import { dispatch } from '../src/dispatch.js';
import { defaultAdapterFor } from '../src/dispatcher/adapters.js';
import { billingVerdict } from '../src/dispatcher/billing.js';
import { materializeWorkerMcp, nativeClientIntegrationInstalled, validateWorkerMcp, webCapable } from '../src/mcp.js';
import { modelFamily, sameModelFamily } from '../src/model-family.js';
import { directRoute, loadRouting } from '../src/routing.js';
import { modelFamilyPack } from '../src/skillpacks.js';
import { serverDefinitions } from '../src/client-config.js';
import { CommsLog } from '../src/comms/log.js';
import type { WorkerAdapter } from '../src/types.js';
import { IDENTITIES, initRepoFixture, useTempResources } from './helpers.js';

const savedCommsDb = process.env.HEDDLE_COMMS_DB;
afterEach(() => {
  if (savedCommsDb === undefined) delete process.env.HEDDLE_COMMS_DB;
  else process.env.HEDDLE_COMMS_DB = savedCommsDb;
});

function installedConfig(dir: string, client: 'codex' | 'cursor' | 'gemini' | 'opencode', agent = 'U'): string {
  const definitions = serverDefinitions(dir, client, agent);
  if (client === 'codex') return stringifyToml({ mcp_servers: definitions });
  if (client === 'opencode') {
    const mcp = Object.fromEntries(Object.entries(definitions).map(([name, def]) => [name, {
      type: 'local', command: [def.command, ...def.args], environment: def.env, enabled: true,
    }]));
    return JSON.stringify({ mcp });
  }
  return JSON.stringify({ mcpServers: definitions });
}

function writeConfig(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('native provider policy', () => {
  const { tempDir: tempAlias, tempLedger } = useTempResources('heddle-native-provider-policy-');
  const tempDir = () => realpathSync(tempAlias());
  const table = loadRouting();

  it('registers additive adapters without changing legacy gemini/agy', () => {
    expect(defaultAdapterFor('gemini').name).toBe('agy');
    expect(defaultAdapterFor('gemini-cli').provider).toBe('gemini-cli');
    expect(defaultAdapterFor('opencode').provider).toBe('opencode');
  });

  it('admits only declared native catalogs and blocks OpenCode laundering', () => {
    expect(directRoute(table, 'gemini-cli', 'gemini-3.1-pro-preview').provider).toBe('gemini-cli');
    expect(directRoute(table, 'opencode', 'opencode/nemotron-3-ultra-free').provider).toBe('opencode');
    expect(() => directRoute(table, 'opencode', 'anthropic/claude-opus-4-6')).toThrow(/direct-subscription family/);
    expect(() => directRoute(table, 'opencode', 'openai/gpt-5.6')).toThrow(/direct-subscription family/);
    expect(() => directRoute(table, 'opencode', 'openrouter/some-paid-model')).toThrow(/not in the verified model catalog/);
  });

  it('classifies native billing from the strict catalog instead of degrading unregistered', () => {
    for (const provider of ['gemini-cli', 'opencode']) {
      expect(billingVerdict({ accountId: null, provider, caps: undefined, permitPayPerToken: false, table }))
        .toEqual({});
    }
  });

  it('normalizes harnesses to the actual model family for review diversity', () => {
    expect(modelFamily('gemini-cli', 'gemini-3.1-pro-preview')).toBe('gemini');
    expect(sameModelFamily('gemini', 'gemini-3.1-pro-high', 'gemini-cli', 'gemini-3.1-pro-preview')).toBe(true);
    expect(sameModelFamily('claude', 'opus', 'opencode', 'anthropic/claude-opus-4-6')).toBe(true);
    expect(sameModelFamily('codex', 'gpt-5.6-terra', 'opencode', 'openai/gpt-5.6')).toBe(true);
    expect(sameModelFamily('codex', 'gpt-5.6-terra', 'opencode', 'opencode/nemotron-3-ultra-free')).toBe(false);
    expect(modelFamilyPack('gemini-cli')).toBe('family-gemini');
  });

  it('treats native Gemini grounding as web capable', () => {
    expect(webCapable('gemini-cli', [])).toBe(true);
  });

  it('materializes loadable Gemini and OpenCode MCP config and restores exact bytes', () => {
    const geminiDir = tempDir();
    const geminiPath = join(geminiDir, '.gemini', 'settings.json');
    validateWorkerMcp('gemini-cli', ['memtrace']);
    const restoreGemini = materializeWorkerMcp(geminiDir, 'gemini-cli', ['memtrace'], { dispatchId: 1 });
    expect(JSON.parse(readFileSync(geminiPath, 'utf8')).mcpServers.memtrace).toEqual({ command: 'memtrace', args: ['mcp'] });
    restoreGemini();
    expect(() => readFileSync(geminiPath, 'utf8')).toThrow();

    const openCodeDir = tempDir();
    const openCodePath = join(openCodeDir, 'opencode.json');
    writeFileSync(openCodePath, '{"theme":"heddle"}\n');
    validateWorkerMcp('opencode', ['memtrace']);
    const restoreOpenCode = materializeWorkerMcp(openCodeDir, 'opencode', ['memtrace'], { dispatchId: 2 });
    expect(JSON.parse(readFileSync(openCodePath, 'utf8'))).toMatchObject({
      theme: 'heddle', mcp: { memtrace: { type: 'local', command: ['memtrace', 'mcp'], enabled: true } },
    });
    restoreOpenCode();
    expect(readFileSync(openCodePath, 'utf8')).toBe('{"theme":"heddle"}\n');
  });

  it('refuses overlapping native identities and permits retry after restoration', () => {
    const dir = tempDir();
    const path = join(dir, '.cursor', 'mcp.json');
    const original = installedConfig(dir, 'cursor');
    writeConfig(path, original);
    const context = (id: number) => ({
      HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: String(id), HEDDLE_PARENT: 'U',
      HEDDLE_COMMS_ADDRESS: `U.${id}`, HEDDLE_AGENT: `U.${id}`, FLEET_AGENT: `U.${id}`,
    });
    const first = materializeWorkerMcp(dir, 'cursor', [], { dispatchId: 11 }, context(11));
    const active = readFileSync(path, 'utf8');
    expect(() => materializeWorkerMcp(dir, 'cursor', [], { dispatchId: 12 }, context(12)))
      .toThrow(/owned by active dispatch #11/);
    expect(readFileSync(path, 'utf8')).toBe(active);
    // Generic discovery refs remain shareable without replacing either native identity definition.
    const discovery = materializeWorkerMcp(dir, 'cursor', ['memtrace'], { dispatchId: 13 });
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.heddle.env.HEDDLE_AGENT).toBe('U.11');
    discovery();
    first();
    expect(readFileSync(path, 'utf8')).toBe(original);
    const second = materializeWorkerMcp(dir, 'cursor', [], { dispatchId: 12 }, context(12));
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.heddle.env.HEDDLE_AGENT).toBe('U.12');
    second();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('restores OpenCode original bytes when the CLI only reformats its native worker config', () => {
    const dir = tempDir(), path = join(dir, 'opencode.json');
    const original = installedConfig(dir, 'opencode');
    writeConfig(path, original);
    const restore = materializeWorkerMcp(dir, 'opencode', [], { dispatchId: 1 }, {
      HEDDLE_WORKER: '1', HEDDLE_AGENT: 'U.1', HEDDLE_COMMS_ADDRESS: 'U.1',
    });
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))));
    restore();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('clears native worker stamps while preserving OpenCode schema and unrelated additions', () => {
    const dir = tempDir(), path = join(dir, 'opencode.json');
    const original = installedConfig(dir, 'opencode');
    writeConfig(path, original);
    const restore = materializeWorkerMcp(dir, 'opencode', [], { dispatchId: 1 }, {
      HEDDLE_WORKER: '1', HEDDLE_AGENT: 'U.1', HEDDLE_COMMS_ADDRESS: 'U.1',
    });
    const active = JSON.parse(readFileSync(path, 'utf8'));
    expect(active.mcp.heddle.timeout).toBe(660_000);
    expect(active.mcp['heddle-comms'].timeout).toBe(660_000);
    active.$schema = 'https://opencode.ai/config.json';
    active.theme = 'operator-theme';
    active.mcp.custom = { type: 'local', command: ['custom-server'] };
    writeFileSync(path, JSON.stringify(active));
    restore();
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result).toMatchObject({ $schema: active.$schema, theme: active.theme, mcp: { custom: active.mcp.custom } });
    expect(result.mcp.heddle).toEqual(JSON.parse(original).mcp.heddle);
    expect(result.mcp['heddle-comms']).toEqual(JSON.parse(original).mcp['heddle-comms']);
    expect(readFileSync(path, 'utf8')).not.toContain('HEDDLE_WORKER');
  });

  it('includes OpenCode startup schema in the read-only baseline and still rejects substantive writes', async () => {
    const priorRouting = process.env.HEDDLE_ROUTING;
    const routingPath = join(tempDir(), 'routing.yaml');
    writeFileSync(routingPath, `version: 0
providers:
  opencode: {execution: headless, billing_class: free-tier}
task_classes:
  schema-review:
    provider: opencode
    model: opencode/nemotron-3-ultra-free
    skills: []
    mcp: [memtrace]
    read_only: true
    edits_code: false
    auto_assess: false
`);
    process.env.HEDDLE_ROUTING = routingPath;
    try {
      for (const initialized of [false, true]) {
        for (const mutation of [false, true]) {
          const dir = initRepoFixture(tempDir(), 'worker', { linkedWorktree: true });
          const path = join(dir, 'opencode.json');
          const original = initialized ? installedConfig(dir, 'opencode') : null;
          if (original !== null) writeConfig(path, original);
          process.env.HEDDLE_COMMS_DB = join(tempDir(), 'comms.db');
          let invoked = false;
          const adapter: WorkerAdapter = {
            name: 'opencode-startup', provider: 'opencode',
            async dispatch(_prompt, opts) {
              try {
                invoked = true;
                expect(opts.readOnly).toBe(true);
                const config = JSON.parse(readFileSync(path, 'utf8'));
                // Reproduce the real CLI's startup normalization only when the schema is absent.
                // With the fix this write is unnecessary; without it the mandate check fails.
                if (!config.$schema) {
                  config.$schema = 'https://opencode.ai/config.json';
                  writeFileSync(path, JSON.stringify(config, null, 2));
                }
                if (mutation) {
                  config.model = 'unexpected-model-change';
                  writeFileSync(path, JSON.stringify(config, null, 2));
                }
                return { ok: true, output: 'review result', exitCode: 0 };
              } catch (error) { throw new Error(`OpenCode startup fixture failed: ${String(error)}`); }
            },
          };
          const outcome = await dispatch({
            taskClass: 'schema-review', cwd: dir, prompt: 'read-only review', identity: IDENTITIES.boundU,
          }, tempLedger(), () => adapter);
          expect(invoked, outcome.error).toBe(true);
          if (mutation) {
            expect(outcome.ok).toBe(false);
            expect(outcome.quarantine).toMatchObject({ reason: 'mandate-violation', output: 'review result' });
            expect(JSON.parse(readFileSync(path, 'utf8')).model).toBe('unexpected-model-change');
          } else {
            expect(outcome.ok, outcome.error).toBe(true);
            expect(outcome.quarantine).toBeUndefined();
            if (original === null) expect(existsSync(path)).toBe(false);
            else expect(readFileSync(path, 'utf8')).toBe(original);
          }
        }
      }
    } finally {
      if (priorRouting === undefined) delete process.env.HEDDLE_ROUTING;
      else process.env.HEDDLE_ROUTING = priorRouting;
    }
  });

  it('mints a real child and supplies sanitized worker MCP env on an initialized direct route', async () => {
    const dir = tempDir();
    const commsDb = join(tempDir(), 'comms.db');
    process.env.HEDDLE_COMMS_DB = commsDb;
    const path = join(dir, 'opencode.json');
    const original = installedConfig(dir, 'opencode');
    writeConfig(path, original);
    let captured: any;
    const adapter: WorkerAdapter = {
      name: 'capture-opencode', provider: 'opencode',
      dispatch: async (_prompt, opts) => {
        captured = { opts, config: JSON.parse(readFileSync(path, 'utf8')) };
        return { ok: true, output: 'done', exitCode: 0, sessionId: 'ses_test' };
      },
    };
    const ledger = tempLedger();
    const outcome = await dispatch({
      provider: 'opencode', model: 'opencode/nemotron-3-ultra-free', prompt: 'work', cwd: dir,
      overrideReason: 'native worker integration regression', identity: IDENTITIES.boundU,
    }, ledger, () => adapter);
    expect(outcome.ok).toBe(true);
    expect(captured.opts.env).toMatchObject({
      HEDDLE_WORKER: '1', HEDDLE_PARENT: 'U', HEDDLE_COMMS_ADDRESS: 'U.1',
    });
    expect(captured.config.mcp.heddle.environment).toMatchObject({
      HEDDLE_WORKER: '1', HEDDLE_PARENT: 'U', HEDDLE_AGENT: 'U.1', FLEET_AGENT: 'U.1',
      HEDDLE_COMMS_ADDRESS: 'U.1', HEDDLE_COMMS_DB: commsDb,
    });
    expect(captured.config.mcp.heddle.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(readFileSync(path, 'utf8')).toBe(original);
    const log = new CommsLog(commsDb, { readOnly: true });
    try {
      expect(log.participant('U.1')).toMatchObject({ parent: 'U', dispatchId: outcome.ledgerId });
    } finally {
      log.close();
    }
  });

  it('recognizes generated native integration configs for all four worker providers', () => {
    const rows = [
      ['codex', 'codex', '.codex/config.toml'],
      ['cursor', 'cursor', '.cursor/mcp.json'],
      ['gemini-cli', 'gemini', '.gemini/settings.json'],
      ['opencode', 'opencode', 'opencode.json'],
    ] as const;
    for (const [provider, client, relative] of rows) {
      const dir = tempDir();
      writeConfig(join(dir, relative), installedConfig(dir, client));
      expect(nativeClientIntegrationInstalled(dir, provider)).toBe(true);
    }
  });

  it('fails closed when OpenCode JSONC prevents safe additive materialization', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'opencode.jsonc'), '{}');
    expect(() => materializeWorkerMcp(dir, 'opencode', ['memtrace'], { dispatchId: 3 }))
      .toThrow(/opencode\.jsonc.*cannot safely materialize/i);
  });
});
