import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { buildWorkerEnv } from '../src/env.js';
import type { ClaudeAccount } from '../src/capaware.js';
import type { ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const accounts: ClaudeAccount[] = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.claude-acct2' }, { id: 'acct3', configDir: '/x/.claude-acct3' }];
const claudeCaps = (rows: Array<{ id: string; used: number | null; stale?: boolean }>): ProviderCaps => ({ provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], activeAccount: null, accounts: rows.map(({ id, used, stale = false }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale })) });

describe('dispatch — headless Claude workers', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-claude-test-');
  const { unbound } = IDENTITIES;

  it('runs the default headless research route under the selected account without writing AGENTS.md', async () => {
    const cwd = tempDir(); const ledger = tempLedger(); const fake = fakeAdapter(undefined, { readAgents: false }); let absentDuringCall = false;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => { absentDuringCall = !existsSync(join(opts.cwd, 'AGENTS.md')); return fake.adapter.dispatch(prompt, opts); } };
    const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd, identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: 1 }]) } }, ledger, () => adapter);
    expect(fake.calls).toHaveLength(1); expect(absentDuringCall).toBe(true); expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(fake.calls[0].opts).toMatchObject({ model: 'haiku', env: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' }, envUnset: [] });
    expect(fake.calls[0].opts.systemPromptAppend).toContain('### worker-role'); expect(fake.calls[0].opts.mcpConfigPath).toBeUndefined();
    expect(outcome).toMatchObject({ account: 'acct2' }); expect(outcome.routeReason).toContain('account:acct2');
    expect(ledger.recent(1)[0]).toMatchObject({ account: 'acct2', provider: 'claude', model: 'haiku', ok: 1 });
  });

  it('unsets the inherited Claude config directory when the selected account is the default login', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: null, stale: true }]) } }, tempLedger(), () => fake.adapter);
    expect(fake.calls[0].opts.env).not.toHaveProperty('CLAUDE_CONFIG_DIR'); expect(fake.calls[0].opts.envUnset).toEqual(['CLAUDE_CONFIG_DIR']); expect(outcome.account).toBe('acct1');
  });

  it('uses an explicitly pinned Claude account and records the pinned account in the ledger', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accountPin: 'acct3', accounts, caps: { claude: claudeCaps([{ id: 'acct3', used: null, stale: true }]) } }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.env?.CLAUDE_CONFIG_DIR).toBe('/x/.claude-acct3'); expect(outcome.routeReason).toContain('pinned'); expect(ledger.recent(1)[0].account).toBe('acct3');
  });

  it('returns a ledgered Claude in-session refusal without invoking a headless adapter', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, inSession: true, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: 1 }]) } }, ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('claude-in-session'); expect(outcome.refusal?.instruction).toContain('Claude accounts:'); expect(fake.calls).toHaveLength(0); expect(ledger.recent(1)[0].refusal).toBe('claude-in-session');
  });

  it('passes Claude MCP through a temporary config file and composes the implementation skill packs', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); let mcpDuringCall: unknown;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => { expect(opts.mcpConfigPath).toBeDefined(); expect(existsSync(opts.mcpConfigPath!)).toBe(true); mcpDuringCall = JSON.parse(readFileSync(opts.mcpConfigPath!, 'utf8')); return fake.adapter.dispatch(prompt, opts); } };
    const outcome = await dispatch({ taskClass: 'implementation', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }, { id: 'acct2', used: 2 }]) } }, tempLedger(), () => adapter);
    expect(mcpDuringCall).toEqual({ mcpServers: { memtrace: { command: 'memtrace', args: ['mcp'] } } }); expect(existsSync(fake.calls[0].opts.mcpConfigPath!)).toBe(false);
    expect(fake.calls[0].opts.systemPromptAppend).toContain('### code-discovery'); expect(fake.calls[0].opts.systemPromptAppend).toContain('### quality-gate'); expect(outcome.ok).toBe(true);
  });

  it('passes enforceable Claude browse capabilities through and refuses unenforceable net capability requests', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const granted = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, capabilities: ['browse'], accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.capabilities).toEqual(['browse']); expect(ledger.recent(1)[0].capabilities).toBe('browse');
    const denied = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, capabilities: ['net'], accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, ledger, () => fake.adapter);
    expect(denied.refusal?.code).toBe('capability-denied'); expect(fake.calls).toHaveLength(1);
  });

  it('stamps Claude worker environments with the worker marker and ledger dispatch id', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, tempLedger(), () => fake.adapter);
    expect(fake.calls[0].opts.env).toMatchObject({ HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: String(outcome.ledgerId) });
  });

  it('builds worker environments by unsetting selected account variables and stripping billing credentials', () => {
    const previousClaude = process.env.CLAUDE_CONFIG_DIR; const previousKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.CLAUDE_CONFIG_DIR = '/parent/.claude-acctX'; process.env.ANTHROPIC_API_KEY = 'test-key';
      const unset = buildWorkerEnv({ overrides: {}, unset: ['CLAUDE_CONFIG_DIR'] });
      expect(unset.env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(unset.stripped).toContain('CLAUDE_CONFIG_DIR'); expect(unset.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(unset.stripped).toContain('ANTHROPIC_API_KEY');
      expect(buildWorkerEnv({ overrides: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' } }).env.CLAUDE_CONFIG_DIR).toBe('/x/.claude-acct2');
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
