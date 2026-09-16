import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { FLEET_CLIENTS, parseFleetClients, planClientInstall } from '../src/client-config.js';
import { applyInstall, planInstall, redactReport } from '../src/init-project.js';
import { useTempResources } from './helpers.js';
import { runCli } from './helpers/cli.js';

describe('native fleet client installation', () => {
  const { tempDir } = useTempResources('heddle-client-config-');
  function options() { return { dir: realpathSync.native(tempDir()), clients: [...FLEET_CLIENTS], agent: 'codex-test' }; }

  it('adds all client formats, preserves Claude files and existing settings, and is idempotent', () => {
    const opts = options();
    mkdirSync(join(opts.dir, '.claude'));
    mkdirSync(join(opts.dir, '.cursor'));
    mkdirSync(join(opts.dir, '.codex'));
    const claude = '{"hooks":{"Stop":[]},"permissions":{"deny":["Bash(rm *)"]}}\n';
    const cursor = '{"mcpServers":{"existing":{"command":"custom"}},"other":42}\n';
    const codex = '# keep this comment\nmodel = "custom"\n[mcp_servers.existing]\ncommand = "custom"\n';
    writeFileSync(join(opts.dir, '.claude/settings.json'), claude);
    writeFileSync(join(opts.dir, '.mcp.json'), '{"mcpServers":{"claude-only":{}}}\n');
    writeFileSync(join(opts.dir, '.cursor/mcp.json'), cursor);
    writeFileSync(join(opts.dir, '.codex/config.toml'), codex);
    writeFileSync(join(opts.dir, 'AGENTS.md'), 'Original project instructions.\n');
    applyInstall(planClientInstall(opts));
    expect(readFileSync(join(opts.dir, '.claude/settings.json'), 'utf8')).toBe(claude);
    expect(readFileSync(join(opts.dir, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{"claude-only":{}}}\n');
    expect(readFileSync(join(opts.dir, '.cursor/mcp.json.heddle-backup'), 'utf8')).toBe(cursor);
    expect(readFileSync(join(opts.dir, '.codex/config.toml.heddle-backup'), 'utf8')).toBe(codex);
    const toml = readFileSync(join(opts.dir, '.codex/config.toml'), 'utf8');
    expect(toml.startsWith(codex)).toBe(true);
    expect(parseToml(toml)).toMatchObject({ model: 'custom', mcp_servers: { existing: { command: 'custom' }, heddle: { env: { HEDDLE_AGENT: 'codex-test' }, tool_timeout_sec: 660 } } });
    const read = (path: string) => JSON.parse(readFileSync(join(opts.dir, path), 'utf8'));
    expect(read('.cursor/mcp.json')).toMatchObject({ other: 42, mcpServers: { existing: { command: 'custom' }, 'heddle-comms': { env: { HEDDLE_CLIENT: 'cursor' } } } });
    expect(read('.gemini/settings.json').mcpServers.heddle).toMatchObject({ env: { HEDDLE_CLIENT: 'gemini' }, timeout: 660_000 });
    expect(read('opencode.json').mcp.heddle).toMatchObject({ type: 'local', enabled: true, environment: { HEDDLE_CLIENT: 'opencode' }, timeout: 660_000 });
    expect(readFileSync(join(opts.dir, 'AGENTS.md'), 'utf8')).toMatch(/^Original project instructions/);
    expect(readFileSync(join(opts.dir, 'GEMINI.md'), 'utf8')).toContain('check_inbox');
    expect(planClientInstall(opts).steps.every((step) => step.action === 'ok')).toBe(true);
  });

  it('plans without writing, aborts every write on a raced file, and redacts existing secrets', () => {
    const opts = options();
    mkdirSync(join(opts.dir, '.cursor'));
    writeFileSync(join(opts.dir, '.cursor/mcp.json'), '{"private":"synthetic-secret"}');
    const plan = planClientInstall({ ...opts, dryRun: true });
    const report = applyInstall(plan);
    expect(existsSync(join(opts.dir, '.codex'))).toBe(false);
    expect(JSON.stringify(redactReport(report, false, opts.dir))).not.toContain('synthetic-secret');
    const real = planClientInstall(opts);
    writeFileSync(join(opts.dir, '.cursor/mcp.json'), '{"changed":true}');
    expect(() => applyInstall(real)).toThrow('changed underneath');
    expect(existsSync(join(opts.dir, '.codex'))).toBe(false);
  });

  it('refuses conflicting servers, malformed configs, duplicate blocks, and invalid identities', () => {
    const opts = options();
    mkdirSync(join(opts.dir, '.cursor'));
    writeFileSync(join(opts.dir, '.cursor/mcp.json'), '{"mcpServers":{"heddle":{"command":"operator-owned"}}}');
    expect(() => planClientInstall(opts)).toThrow('different configuration');
    expect(existsSync(join(opts.dir, '.codex'))).toBe(false);
    writeFileSync(join(opts.dir, '.cursor/mcp.json'), '[1]');
    expect(() => planClientInstall(opts)).toThrow('must be an object');
    mkdirSync(join(opts.dir, '.codex'));
    writeFileSync(join(opts.dir, '.codex/config.toml'), '# heddle fleet MCP: begin\n');
    expect(() => planClientInstall(opts)).toThrow('malformed');
    writeFileSync(join(opts.dir, '.codex/config.toml'), 'invalid = "synthetic-secret');
    expect(() => planClientInstall(opts)).toThrow('invalid Codex TOML');
    try { planClientInstall(opts); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
    expect(() => planClientInstall({ ...opts, agent: 'operator' })).toThrow('fleet agent');
    expect(() => parseFleetClients('codex,')).toThrow('--clients');
    expect(parseFleetClients('codex,cursor,codex')).toEqual(['codex', 'cursor']);
  });

  it('does not follow client config symlinks or overwrite existing OpenCode JSONC', () => {
    const opts = options(), elsewhere = tempDir();
    symlinkSync(elsewhere, join(opts.dir, '.codex'));
    expect(() => planClientInstall(opts)).toThrow('symlink');
    writeFileSync(join(opts.dir, 'opencode.jsonc'), '// operator settings\n{}');
    expect(() => planClientInstall({ ...opts, clients: ['opencode'] })).toThrow('opencode.jsonc');
    expect(existsSync(join(opts.dir, 'opencode.json'))).toBe(false);
  });

  it('preserves marker examples in prose and handles standalone CRLF markers at EOF', () => {
    const opts = { ...options(), clients: ['cursor'] as const };
    const path = join(opts.dir, 'AGENTS.md');
    const prose = 'Example: <!-- heddle fleet: begin --> keep this policy <!-- heddle fleet: end -->.\n';
    writeFileSync(path, prose + '<!-- heddle fleet: begin -->\r\nold guidance\r\n<!-- heddle fleet: end -->');
    applyInstall(planClientInstall({ ...opts, clients: [...opts.clients] }));
    const next = readFileSync(path, 'utf8');
    expect(next.startsWith(prose)).toBe(true);
    expect(next).not.toContain('old guidance');
    expect(next).toContain('60-second MCP call timeout');
  });

  it('rejects a canonical home target even when the home setting is a symlink', () => {
    const opts = options(), alias = join(tempDir(), 'home-alias');
    symlinkSync(opts.dir, alias);
    expect(() => planClientInstall({ ...opts, homeDir: alias })).toThrow('home directory');
  });

  it('accepts an explicitly selected symlink to a project and binds the canonical workspace', () => {
    const opts = options(), alias = join(tempDir(), 'project-alias');
    symlinkSync(opts.dir, alias);
    const plan = planClientInstall({ ...opts, dir: alias });
    expect(plan.options.dir).toBe(opts.dir);
    expect(plan.steps.every((step) => step.path.startsWith(opts.dir + '/'))).toBe(true);
  });

  it('rejects a parent symlink inserted after planning before writing any files', () => {
    const opts = options(), elsewhere = tempDir();
    mkdirSync(join(opts.dir, '.cursor'));
    const plan = planClientInstall(opts);
    renameSync(join(opts.dir, '.cursor'), join(opts.dir, '.cursor-original'));
    symlinkSync(elsewhere, join(opts.dir, '.cursor'));
    expect(() => applyInstall(plan)).toThrow('symlink');
    expect(existsSync(join(opts.dir, '.codex'))).toBe(false);
    expect(existsSync(join(elsewhere, 'mcp.json'))).toBe(false);
  });

  it('detects edits made while earlier client files are being written', () => {
    const opts = options(), path = join(opts.dir, 'AGENTS.md');
    writeFileSync(path, 'original instructions');
    const plan = planClientInstall(opts), first = plan.steps[0], content = first.content;
    let edited = false;
    Object.defineProperty(first, 'content', { get() {
      if (!edited) { edited = true; writeFileSync(path, 'concurrent operator edit'); }
      return content;
    } });
    expect(() => applyInstall(plan)).toThrow('changed underneath');
    expect(readFileSync(path, 'utf8')).toBe('concurrent operator edit');
  });

  it('never replaces an existing immutable backup even without a snapshot precondition', () => {
    const opts = options(), path = join(opts.dir, 'AGENTS.md');
    writeFileSync(path, 'original');
    const plan = planClientInstall(opts), backup = plan.steps.find((step) => step.step === 'client-instructions:AGENTS.md:backup')!;
    expect(backup.exclusive).toBe(true);
    writeFileSync(backup.path, 'another installer backup');
    expect(() => applyInstall({ ...plan, steps: [{ ...backup, expectedContent: undefined }] })).toThrow('EEXIST');
    expect(readFileSync(backup.path, 'utf8')).toBe('another installer backup');
    expect(readFileSync(path, 'utf8')).toBe('original');
  });

  it('composes with init-project while default Claude initialization remains opt-in free', () => {
    const opts = options();
    const canonical = join(opts.dir, 'canonical');
    mkdirSync(join(canonical, 'hooks'), { recursive: true });
    for (const hook of ['agent-identity.py', 'agent-preflight.py', 'remind-owned-prs.py', 'require-memtrace-first.py', 'delegation-nudge.py', 'require-pr-sweep.py']) writeFileSync(join(canonical, 'hooks', hook), '');
    const base = { dir: opts.dir, canonical, homeDir: tempDir(), team: 'TEST', agents: 'test-A', room: '#test' };
    const original = planInstall(base);
    const extended = planInstall({ ...base, clients: ['codex', 'gemini'] });
    expect(extended.steps.slice(0, original.steps.length)).toEqual(original.steps);
    expect(original.steps.some((step) => step.step.startsWith('client:'))).toBe(false);
    expect(extended.steps.map((step) => step.step)).toEqual(expect.arrayContaining(['client:codex', 'client:gemini']));
  });

  it('the built CLI installs without printing config contents and rejects missing selectors', async () => {
    const opts = options();
    try {
      const run = await runCli(['init-client', opts.dir, '--clients', 'codex,cursor', '--agent', opts.agent, '--json']);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).steps.some((step: { step: string }) => step.step === 'client:codex')).toBe(true);
      expect(run.stdout).not.toContain('expectedContent');
      expect(run.stdout).not.toContain('HEDDLE_AGENT');
      expect((await runCli(['init-client', opts.dir, '--clients'])).code).not.toBe(0);
    } catch (error) { throw new Error(`client CLI integration failed: ${String(error)}`); }
  });
});
