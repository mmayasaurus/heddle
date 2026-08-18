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
    expect(fake.calls[0].opts.systemPromptAppend).toContain('### worker-role'); // no MCP requested → still a per-dispatch config file (EMPTY servers) so --strict-mcp-config hides the operator's global servers
    expect(fake.calls[0].opts.mcpConfigPath).toMatch(/mcp\.json$/);
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

  it('records the current Claude account and names the reportable ledger id in an in-session instruction', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
      const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, inSession: true, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: 1 }]) } }, ledger, () => fake.adapter);
      expect(ledger.recent(1)[0]).toMatchObject({ account: 'acct1', refusal: 'claude-in-session' });
      expect(outcome.refusal?.instruction).toContain(`report_in_session(id=${outcome.ledgerId}`);
      expect(outcome.refusal?.instruction).toContain(`report-in-session ${outcome.ledgerId} --ok`);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it('passes Claude MCP through a temporary config file and composes the implementation skill packs', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); let mcpDuringCall: unknown;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => { expect(opts.mcpConfigPath).toBeDefined(); expect(existsSync(opts.mcpConfigPath!)).toBe(true); mcpDuringCall = JSON.parse(readFileSync(opts.mcpConfigPath!, 'utf8')); return fake.adapter.dispatch(prompt, opts); } };
    const outcome = await dispatch({ taskClass: 'implementation', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }, { id: 'acct2', used: 2 }]) } }, tempLedger(), () => adapter);
    expect(mcpDuringCall).toEqual({ mcpServers: { memtrace: { command: 'memtrace', args: ['mcp'] } } }); expect(existsSync(fake.calls[0].opts.mcpConfigPath!)).toBe(false);
    expect(fake.calls[0].opts.systemPromptAppend).toContain('### code-discovery'); expect(fake.calls[0].opts.systemPromptAppend).toContain('### quality-gate'); expect(outcome.ok).toBe(true);
  });

  it('passes enforceable Claude browse capabilities through, and net routes to the enforcing codex fallback (capability-fit)', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const granted = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, capabilities: ['browse'], accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.capabilities).toEqual(['browse']); expect(ledger.recent(1)[0].capabilities).toBe('browse');
    // claude cannot enforce `net` (no sandbox), but research-summarize's declared codex fallback can —
    // capability-fit routing runs it there instead of a terminal refusal.
    const fit = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, capabilities: ['net'], accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, ledger, () => fake.adapter);
    expect(fit.ok).toBe(true);
    expect(fit.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].opts.model).toBe('gpt-5.6-luna');
    expect(fake.calls[1].opts.capabilities).toEqual(['net']);
    expect(ledger.recent(1)[0]).toMatchObject({ model: 'gpt-5.6-luna', capabilities: 'net', fell_back_from: 'claude/haiku (capability-unenforceable)' });
  });

  it('stamps Claude worker environments with the worker marker and ledger dispatch id', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const outcome = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, tempLedger(), () => fake.adapter);
    expect(fake.calls[0].opts.env).toMatchObject({ HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: String(outcome.ledgerId) });
  });

  it('strips every billing switch and the inherited Claude OAuth token, while explicit account selectors pass', () => {
    const saved: Record<string, string | undefined> = {};
    const vars = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
    for (const v of vars) { saved[v] = process.env[v]; process.env[v] = `test-${v}`; }
    try {
      const built = buildWorkerEnv({});
      // billing switches: silently move billing off the subscription in headless mode
      expect(built.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(built.env.ANTHROPIC_BASE_URL).toBeUndefined();
      // inherited OAuth token: outranks the config-dir OAuth inside claude — would pin every worker
      // to the token's account and defeat rotation (codex-connector P1)
      expect(built.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(built.stripped).toEqual(expect.arrayContaining(vars));
      // …but an EXPLICIT override is an account selector and passes through
      expect(buildWorkerEnv({ overrides: { CLAUDE_CODE_OAUTH_TOKEN: 'chosen' } }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('chosen');
    } finally {
      for (const v of vars) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
    }
  });

  it('picks a fresh Claude account for a claude FALLBACK after a non-claude primary fails, and ledgers it', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    let call = 0;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      call += 1;
      if (call === 1) { await fake.adapter.dispatch(prompt, opts); return { ok: false, output: '', exitCode: 1, error: 'primary boom' }; }
      return fake.adapter.dispatch(prompt, opts);
    } };
    // synthetic table: codex primary, claude fallback
    const { writeFileSync } = await import('node:fs'); const { join: joinPath } = await import('node:path');
    const yaml = joinPath(tempDir(), 'routing.yaml');
    writeFileSync(yaml, ['version: 0', 'providers:', '  codex: { auth: chatgpt-subscription, models: [gpt-5.6-terra] }', '  claude: { auth: anthropic-subscription, execution: headless, models: [haiku] }', 'task_classes:', '  fbtest:', '    provider: codex', '    model: gpt-5.6-terra', '    fallback: { provider: claude, model: haiku }', ''].join('\n'));
    const prevRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = yaml;
    try {
      const outcome = await dispatch({ taskClass: 'fbtest', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 68 }, { id: 'acct2', used: 1 }]) } }, ledger, () => adapter);
      expect(outcome.ok).toBe(true);
      expect(fake.calls).toHaveLength(2);
      // the fallback claude worker runs under the account with the most headroom, not the caller's env
      expect(fake.calls[1].opts.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/x/.claude-acct2' });
      expect(outcome.account).toBe('acct2');
      expect(ledger.recent(1)[0]).toMatchObject({ provider: 'claude', model: 'haiku', account: 'acct2', ok: 1 });
    } finally {
      if (prevRouting === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = prevRouting;
    }
  });

  it('pins a resumed dispatch to the account its session last ran under instead of re-picking by headroom', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    // first dispatch lands on acct3 via pin and persists the session id
    const first = await dispatch({ taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accountPin: 'acct3', accounts, caps: { claude: claudeCaps([{ id: 'acct3', used: null, stale: true }]) } }, ledger, () => ({ ...fake.adapter, dispatch: async (p: string, o: Parameters<typeof fake.adapter.dispatch>[1]) => ({ ...(await fake.adapter.dispatch(p, o)), sessionId: 'sess-affinity' }) }));
    expect(first.sessionId).toBe('sess-affinity');
    expect(ledger.recent(1)[0]).toMatchObject({ account: 'acct3', session_id: 'sess-affinity' });
    // resuming that session re-picks acct3 even though acct2 now has far more headroom
    const resumed = await dispatch({ taskClass: 'research-summarize', prompt: 'more', cwd: tempDir(), resume: 'sess-affinity', identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct2', used: 1 }, { id: 'acct3', used: 90 }]) } }, ledger, () => fake.adapter);
    expect(fake.calls.at(-1)!.opts.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/x/.claude-acct3' });
    expect(fake.calls.at(-1)!.opts.resume).toBe('sess-affinity');
    expect(resumed.account).toBe('acct3');
    expect(resumed.routeReason).toContain('pinned');
  });

  it('hands the attached MCP server names to the claude adapter so the allowlist can include them', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false });
    await dispatch({ taskClass: 'deep-implementation', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) } }, tempLedger(), () => fake.adapter);
    expect(fake.calls[0].opts.mcpServers).toEqual(['memtrace']);
  });

  it('builds worker environments by unsetting selected account variables and stripping billing credentials', () => {
    const previousClaude = process.env.CLAUDE_CONFIG_DIR; const previousKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.CLAUDE_CONFIG_DIR = '/parent/.claude-acctX'; process.env.ANTHROPIC_API_KEY = 'test-key';
      const unset = buildWorkerEnv({ overrides: {}, unset: ['CLAUDE_CONFIG_DIR'] });
      expect(unset.env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(unset.stripped).toContain('CLAUDE_CONFIG_DIR'); expect(unset.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(unset.stripped).toContain('ANTHROPIC_API_KEY');
      expect(buildWorkerEnv({ overrides: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' } }).env.CLAUDE_CONFIG_DIR).toBe('/x/.claude-acct2');
      // unset beats overrides — an override must not re-introduce a var the caller removed (copilot).
      const unsetWins = buildWorkerEnv({ overrides: { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' }, unset: ['CLAUDE_CONFIG_DIR'] });
      expect(unsetWins.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
