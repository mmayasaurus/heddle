import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dispatch, planDispatch, summarizePlan } from '../src/dispatch.js';
import { buildWorkerEnv } from '../src/env.js';
import type { ClaudeAccount } from '../src/capaware.js';
import { readProviderCaps, type ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const accounts: ClaudeAccount[] = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.claude-acct2' }, { id: 'acct3', configDir: '/x/.claude-acct3' }];
const claudeCaps = (rows: Array<{ id: string; used: number | null; stale?: boolean }>): ProviderCaps => ({ provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], activeAccount: null, accounts: rows.map(({ id, used, stale = false }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale })) });

function writeClaudeFallbackRouting(tempDir: () => string): string {
  const yaml = join(tempDir(), 'claude-fallback.yaml');
  writeFileSync(yaml, [
    'version: 0', 'providers:',
    '  claude: { auth: anthropic-subscription, execution: headless, models: [haiku] }',
    '  codex: { auth: chatgpt-subscription, models: [gpt-5.6-terra] }',
    'task_classes:', '  fallback-test:',
    '    provider: codex', '    model: gpt-5.6-terra',
    '    fallback: { provider: claude, model: haiku }', '',
  ].join('\n'));
  return yaml;
}

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

  it('passes Claude MCP through a temporary config file and composes the deep-implementation skill packs', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); let mcpDuringCall: unknown;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => { expect(opts.mcpConfigPath).toBeDefined(); expect(existsSync(opts.mcpConfigPath!)).toBe(true); mcpDuringCall = JSON.parse(readFileSync(opts.mcpConfigPath!, 'utf8')); return fake.adapter.dispatch(prompt, opts); } };
    const outcome = await dispatch({ taskClass: 'deep-implementation', prompt: 'x', cwd: tempDir(), identity: unbound, accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }, { id: 'acct2', used: 2 }]) } }, tempLedger(), () => adapter);
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

describe('regression PR#250 — Claude dispatches require an addressable registered account', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-no-account-test-');
  const { unbound } = IDENTITIES;
  const registry: ClaudeAccount[] = [
    { id: 'acct1', configDir: null },
    { id: 'acct2', configDir: '/x/.claude-acct2' },
  ];

  const capsWithSignals = (signals: Array<{ account: string; reason: 'billing' | 'logged-out' }>) => {
    const usageDir = tempDir();
    const nowS = Math.floor(Date.now() / 1000);
    writeFileSync(join(usageDir, 'limits.json'), JSON.stringify({
      writtenAt: nowS,
      limits: [{ provider: 'claude', capturedAt: nowS, staleAfterSecs: 900, accounts: registry.map((account, index) => ({
        id: account.id, fiveHour: { usedPercentage: index + 1 }, sevenDay: {},
      })) }],
    }));
    for (const signal of signals) {
      writeFileSync(join(usageDir, `claude-${signal.account}.dispatch.json`), JSON.stringify({
        schemaVersion: 1, account: signal.account, dispatchable: false, reason: signal.reason, checkedAt: nowS,
      }));
    }
    return readProviderCaps({ usageDir, nowS }).claude;
  };

  // HED-106 S1 / HED-264 (fallback-not-refusal) FLIP: PR#250 made a dead-account claude PRIMARY REFUSE.
  // The tier-ladder walk now routes it to the class's declared NON-claude fallback instead — PR#250's
  // safety property still holds (we never run claude on a dead account; we run CODEX), but the old
  // 26%-failure refusal becomes a live route. The refusal is PRESERVED where there is no live lane:
  // a claude runtime-FALLBACK with no account, a pinned dead account, and a claude-only class (below).
  it('walks a billing/logged-out claude PRIMARY to its declared codex fallback instead of refusing (HED-264)', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts: registry,
      caps: { claude: capsWithSignals([{ account: 'acct1', reason: 'billing' }, { account: 'acct2', reason: 'logged-out' }]) },
    }, ledger, () => fake.adapter);

    expect(outcome.ok).toBe(true); expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0].opts.model).toBe('gpt-5.6-luna');
    expect(outcome.routeReason).toContain('cap:expand'); expect(outcome.routeReason).toContain('claude/haiku dead(no-account)');
    expect(outcome.routeReason).toContain('codex/gpt-5.6-luna');
    expect(ledger.recent(1)[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', ok: 1 });
  });

  it('walks a fully logged-out claude PRIMARY to its declared codex fallback (HED-264)', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound,
      accounts: registry.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
    }, ledger, () => fake.adapter);

    expect(outcome.ok).toBe(true); expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0].opts.model).toBe('gpt-5.6-luna');
    expect(ledger.recent(1)[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', ok: 1 });
  });

  it('runs when a registered Claude account remains addressable', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false });
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts: registry,
      caps: { claude: capsWithSignals([{ account: 'acct1', reason: 'billing' }]) },
    }, tempLedger(), () => fake.adapter);

    expect(outcome.ok).toBe(true); expect(fake.calls).toHaveLength(1); expect(outcome.account).toBe('acct2');
  });

  it('keeps the inherited login path when no Claude account registry exists', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false });
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accounts: [], caps: { claude: claudeCaps([]) },
    }, tempLedger(), () => fake.adapter);

    expect(outcome.ok).toBe(true); expect(outcome.refusal).toBeUndefined(); expect(fake.calls).toHaveLength(1);
  });

  it('leaves in-session Claude and non-Claude dispatches unchanged', async () => {
    const claude = fakeAdapter(undefined, { readAgents: false });
    const inSession = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, inSession: true,
      accounts: registry.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
    }, tempLedger(), () => claude.adapter);
    expect(inSession.refusal?.code).toBe('claude-in-session'); expect(claude.calls).toHaveLength(0);

    const codex = fakeAdapter();
    const nonClaude = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound }, tempLedger(), () => codex.adapter);
    expect(nonClaude.ok).toBe(true); expect(codex.calls).toHaveLength(1);
  });

  it('dry-run summary shows the HED-264 walk to the codex fallback (dispatch/plan parity, HED-250)', () => {
    const plan = planDispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound,
      accounts: registry.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
    });

    const summary = summarizePlan(plan);
    expect(summary).toMatchObject({ would_run: 'codex/gpt-5.6-luna', routed_away_for_cap: true, refusal: null });
    expect(String(summary.route_reason)).toContain('cap:expand');
  });

  it('preserves the failed primary ledger outcome when a Claude failure fallback has no addressable account', async () => {
    const { writeFileSync } = await import('node:fs'); const { join: joinPath } = await import('node:path');
    const yaml = joinPath(tempDir(), 'claude-fallback.yaml');
    writeFileSync(yaml, [
      'version: 0', 'providers:',
      '  claude: { auth: anthropic-subscription, execution: headless, models: [haiku] }',
      '  codex: { auth: chatgpt-subscription, models: [gpt-5.6-terra] }',
      'task_classes:', '  fallback-test:',
      '    provider: codex', '    model: gpt-5.6-terra',
      '    fallback: { provider: claude, model: haiku }', '',
    ].join('\n'));
    const previousRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = yaml;
    try {
      const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
      const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        await fake.adapter.dispatch(prompt, opts);
        return { ok: false, output: '', exitCode: 1, error: 'primary boom' };
      } };
      const outcome = await dispatch({
        taskClass: 'fallback-test', prompt: 'x', cwd: tempDir(), identity: unbound,
        accounts: registry.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
      }, ledger, () => adapter);

      expect(outcome).toMatchObject({ ok: false, provider: 'codex', model: 'gpt-5.6-terra' });
      expect(outcome.error).toContain('claude fallback blocked: no dispatchable account');
      expect(ledger.recent(2)).toHaveLength(1);
      expect(ledger.recent(2)[0]).toMatchObject({ id: outcome.ledgerId, provider: 'codex', ok: 0, refusal: null });
      expect(ledger.get(outcome.ledgerId)?.error).toContain('primary boom');
      expect(ledger.get(outcome.ledgerId)?.error).toContain('claude fallback blocked: no dispatchable account');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('keeps the no-account fallback reason when best-effort ledger annotation throws', async () => {
    const previousRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = writeClaudeFallbackRouting(tempDir);
    try {
      const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
      vi.spyOn(ledger, 'annotateError').mockImplementation(() => { throw new Error('SQLite handle is closed'); });
      const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        await fake.adapter.dispatch(prompt, opts);
        return { ok: false, output: '', exitCode: 1, error: 'primary boom' };
      } };

      const outcome = await dispatch({
        taskClass: 'fallback-test', prompt: 'x', cwd: tempDir(), identity: unbound,
        accounts: accounts.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
      }, ledger, () => adapter);

      expect(outcome.error).toMatch(/^primary boom; claude fallback blocked: no dispatchable account — no dispatchable Claude account/);
      expect(outcome.error).not.toContain('SQLite handle is closed');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('keeps the pinned-account fallback reason when best-effort ledger annotation throws', async () => {
    const previousRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = writeClaudeFallbackRouting(tempDir);
    try {
      const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
      vi.spyOn(ledger, 'annotateError').mockImplementation(() => { throw new Error('SQLite handle is closed'); });
      const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        await fake.adapter.dispatch(prompt, opts);
        return { ok: false, output: '', exitCode: 1, error: 'primary boom' };
      } };

      const outcome = await dispatch({
        taskClass: 'fallback-test', prompt: 'x', cwd: tempDir(), identity: unbound, accountPin: 'missing',
        accounts, caps: { claude: claudeCaps([{ id: 'acct1', used: 1 }]) },
      }, ledger, () => adapter);

      expect(outcome.error).toContain('primary boom; claude fallback blocked: account_pin "missing" is not in ~/.heddle/accounts.json');
      expect(outcome.error).not.toContain('SQLite handle is closed');
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it.each([
    ['empty', ''],
    ['null', null],
  ])('matches the persisted fallback note when the primary error is %s', async (_kind, primaryError) => {
    const previousRouting = process.env.HEDDLE_ROUTING;
    process.env.HEDDLE_ROUTING = writeClaudeFallbackRouting(tempDir);
    try {
      const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
      const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
        await fake.adapter.dispatch(prompt, opts);
        return { ok: false, output: '', exitCode: 1, error: primaryError as string };
      } };

      const outcome = await dispatch({
        taskClass: 'fallback-test', prompt: 'x', cwd: tempDir(), identity: unbound,
        accounts: accounts.map((account) => ({ ...account, loggedIn: false })), caps: { claude: claudeCaps([]) },
      }, ledger, () => adapter);
      const persisted = ledger.get(outcome.ledgerId)?.error;

      expect(outcome.error).toMatch(/^claude fallback blocked: no dispatchable account — no dispatchable Claude account/);
      expect(outcome.error).toBe(persisted);
      expect(outcome.error).not.toMatch(/^;\s/);
    } finally {
      if (previousRouting === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = previousRouting;
    }
  });

  it('returns a structured refusal for a pinned fresh-billing account without a run row', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: unbound, accountPin: 'acct1', accounts: registry,
      caps: { claude: capsWithSignals([{ account: 'acct1', reason: 'billing' }]) },
    }, ledger, () => fake.adapter);

    expect(outcome).toMatchObject({ ok: false, refusal: { code: 'no-dispatchable-account' } });
    expect(outcome.refusal?.reason).toContain('account_pin "acct1"');
    expect(fake.calls).toHaveLength(0); expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'no-dispatchable-account' });
  });
});
