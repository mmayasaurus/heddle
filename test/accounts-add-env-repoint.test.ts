import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAccountRegistry } from '../src/accounts.js';
import { runAccountsAdd } from '../src/wizard/accounts-add.js';
import { ScriptedPrompter, type Prompter } from '../src/wizard/prompt.js';
import type { CliRunner } from '../src/wizard/cli-runner.js';
import { useTempResources } from './helpers.js';

const fakeRunner: CliRunner = {
  login: () => { throw new Error('env-repoint must not login'); },
  status: () => { throw new Error('env-repoint must not probe status'); },
};

class RecordingPrompter implements Prompter {
  readonly questions: string[] = [];
  constructor(private readonly scripted: ScriptedPrompter) {}
  text(question: string, defaultValue?: string): Promise<string> { this.questions.push(question); return this.scripted.text(question, defaultValue); }
  select(question: string, choices: readonly string[]): Promise<string> { this.questions.push(question); return this.scripted.select(question, choices); }
  confirm(question: string, defaultValue?: boolean): Promise<boolean> { this.questions.push(question); return this.scripted.confirm(question, defaultValue); }
  secret(question: string): Promise<string> { this.questions.push(question); return this.scripted.secret(question); }
  close(): void { this.scripted.close(); }
}

describe('accounts add env-repoint wizard', () => {
  const { tempDir } = useTempResources('heddle-accounts-add-env-repoint-');

  afterEach(() => vi.unstubAllEnvs());

  function withHome(path: string): void {
    vi.stubEnv('HOME', path);
  }

  it('round-trips a GLM credential reference without persisting the fake key', async () => {
    const dir = tempDir();
    const path = join(dir, 'glm.json');
    const fakeValue = 'FAKE_GLM_SENTINEL_VALUE';
    withHome(dir);
    vi.stubEnv('ZAI_API_KEY', fakeValue);
    const report: string[] = [];

    const summary = await runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'global', '', 'ZAI_API_KEY', 'paid', 'T2', false]),
      runner: fakeRunner, report: (line) => report.push(line),
    });

    const account = loadAccountRegistry(path).accounts[0]!;
    expect(summary.added).toEqual(['glm-1']);
    expect(account).toMatchObject({
      id: 'glm-1', provider: 'claude', credentialRef: `claude:glm:${account.configDir}`,
      envRepoint: { baseUrl: 'https://api.z.ai/api/anthropic', authTokenRef: 'ZAI_API_KEY', service: 'glm' },
    });
    expect(account.loggedIn).toBeUndefined();
    expect(statSync(account.configDir!).mode & 0o777).toBe(0o700);
    expect(`${report.join('\n')}\n${readFileSync(path, 'utf8')}`).not.toContain(fakeValue);
  });

  it('honors opts.homeDir for BOTH the registry and the isolated credential dir (no split install)', async () => {
    // Regression for the split-home finding: `heddle setup --home <dir>` must relocate the credential
    // dir too, not just the registry — otherwise the registry lands under <dir> while credential dirs
    // default to the process user's real home.
    const home = tempDir();      // the requested --home
    const realHome = tempDir();  // the process user's real home — must receive nothing
    withHome(realHome);
    vi.stubEnv('HEDDLE_ACCOUNTS', undefined);
    vi.stubEnv('ZAI_API_KEY', 'FAKE_GLM_SENTINEL');
    const summary = await runAccountsAdd({ provider: 'glm', homeDir: home }, {
      prompter: new ScriptedPrompter([true, '', 'global', '', 'ZAI_API_KEY', 'paid', 'T2', false]),
      runner: fakeRunner,
    });
    expect(summary.added).toEqual(['glm-1']);
    const account = loadAccountRegistry(join(home, '.heddle', 'accounts.json')).accounts[0]!;
    expect(account.configDir).toBe(join(home, '.heddle', 'accounts', 'claude', 'glm-1'));
    expect(existsSync(account.configDir!)).toBe(true);
    expect(existsSync(join(home, '.heddle', 'accounts.json'))).toBe(true);
    // Nothing leaked to the process user's real home.
    expect(existsSync(join(realHome, '.heddle'))).toBe(false);
  });

  it('honors opts.homeDir for the NATIVE (claude/codex) credential dir too', async () => {
    // Companion to the env-repoint case above, covering the finding as the reviewers worded it ("Claude
    // and Codex credential directories"): the native login path derives its isolated dir from `home` as
    // well. addOne creates the dir (mkdirSync) BEFORE calling runner.login, so a login that throws still
    // proves the dir landed under the requested --home — no status-probe fixture needed, and the account
    // fails cleanly rather than aborting the wizard.
    const home = tempDir();      // the requested --home
    const realHome = tempDir();  // the process user's real home — must receive nothing
    withHome(realHome);
    vi.stubEnv('HEDDLE_ACCOUNTS', undefined);
    const summary = await runAccountsAdd({ provider: 'claude', homeDir: home }, {
      // confirm "Do you have a Claude account?" → id (empty → default claude-1) → login throws → "any other?" no.
      prompter: new ScriptedPrompter([true, '', false]), runner: fakeRunner,
    });
    expect(summary.failed).toEqual(['claude-1']);
    // The isolated credential dir was created under the requested home, before the failing login.
    expect(existsSync(join(home, '.heddle', 'accounts', 'claude', 'claude-1'))).toBe(true);
    // Nothing leaked to the process user's real home.
    expect(existsSync(join(realHome, '.heddle'))).toBe(false);
  });

  it('records an openai-compat (codex-harness) account with an operator-supplied base URL', async () => {
    // grok has no matrix baseUrl default — the wizard must prompt for it — and repoints the codex harness.
    const path = join(tempDir(), 'grok.json');
    withHome(tempDir());
    vi.stubEnv('XAI_API_KEY', 'FAKE_XAI_SENTINEL');
    const summary = await runAccountsAdd({ provider: 'grok', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'https://api.x.ai/v1', 'XAI_API_KEY', 'paid', 'T1', false]),
      runner: fakeRunner,
    });
    expect(summary.added).toEqual(['grok-1']);
    const account = loadAccountRegistry(path).accounts[0]!;
    expect(account).toMatchObject({
      id: 'grok-1', provider: 'codex', credentialRef: `codex:grok:${account.codexHome}`,
      envRepoint: { baseUrl: 'https://api.x.ai/v1', authTokenRef: 'XAI_API_KEY', service: 'grok' },
    });
    expect(account.configDir).toBeUndefined();
  });

  it('refuses a no-default-baseUrl provider when the operator supplies no URL', async () => {
    const path = join(tempDir(), 'grok-nourl.json');
    withHome(tempDir());
    vi.stubEnv('XAI_API_KEY', 'FAKE_XAI_SENTINEL');
    await expect(runAccountsAdd({ provider: 'grok', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', '']), runner: fakeRunner,
    })).rejects.toThrow(/http\(s\) URL/i);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a credential-shaped fake literal as an environment-variable name', async () => {
    const path = join(tempDir(), 'shape.json');
    withHome(tempDir());
    await expect(runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'bad', 'global', '', 'not-a-valid-env-name']), runner: fakeRunner,
    })).rejects.toThrow(/value, not a name/i);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an unset env-var reference without recording an account', async () => {
    const path = join(tempDir(), 'unset.json');
    const report: string[] = [];
    withHome(tempDir());
    vi.stubEnv('UNSET_ENV_REPOINT_TEST_VAR', '');
    const summary = await runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'missing', 'global', '', 'UNSET_ENV_REPOINT_TEST_VAR', false]),
      runner: fakeRunner, report: (line) => report.push(line),
    });
    expect(summary).toMatchObject({ added: [], failed: ['missing'] });
    expect(loadAccountRegistry(path).accounts).toEqual([]);
    expect(report.join('\n')).toContain('export UNSET_ENV_REPOINT_TEST_VAR and re-run');
  });

  it('does not record Kimi when its trains-on-inputs warning is declined', async () => {
    const path = join(tempDir(), 'kimi-skip.json');
    withHome(tempDir());
    vi.stubEnv('KIMI_TEST_KEY', 'FAKE_KIMI_SENTINEL');
    const report: string[] = [];
    await runAccountsAdd({ provider: 'kimi', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'kimi-1', '', 'KIMI_TEST_KEY', false, false]),
      runner: fakeRunner, report: (line) => report.push(line),
    });
    expect(loadAccountRegistry(path).accounts).toEqual([]);
    expect(report.join('\n')).toContain('SKIP kimi kimi-1');
  });

  it('records trains-on-inputs after the warning is accepted', async () => {
    const path = join(tempDir(), 'kimi-continue.json');
    withHome(tempDir());
    vi.stubEnv('KIMI_CONTINUE_TEST_KEY', 'FAKE_KIMI_CONTINUE_SENTINEL');
    await runAccountsAdd({ provider: 'kimi', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'kimi-1', '', 'KIMI_CONTINUE_TEST_KEY', true, 'free', 'T0', false]),
      runner: fakeRunner,
    });
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({ trainsOnInputs: true, provider: 'claude' });
  });

  it('does not offer blocked NVIDIA without the explicit opt-in', async () => {
    const path = join(tempDir(), 'blocked.json');
    withHome(tempDir());
    const report: string[] = [];
    const summary = await runAccountsAdd({ provider: 'nvidia', registryPath: path }, {
      prompter: new ScriptedPrompter([false]), runner: fakeRunner, report: (line) => report.push(line),
    });
    expect(summary.added).toEqual([]);
    expect(report.join('\n')).toMatch(/SMS verification failures/);
    expect(loadAccountRegistry(path).accounts).toEqual([]);
  });

  it('keeps blocked providers out of the default account list and exposes the opt-in', async () => {
    const path = join(tempDir(), 'blocked-default.json');
    const prompter = new RecordingPrompter(new ScriptedPrompter(Array.from({ length: 16 }, () => false)));
    await runAccountsAdd({ registryPath: path }, { prompter, runner: fakeRunner });
    expect(prompter.questions).not.toContain('Do you have a NVIDIA Build account?');
    expect(prompter.questions).toContain('I already have a working NVIDIA Build key — add it anyway?');
  });

  it('fails one account without aborting the wizard when its isolated dir already exists', async () => {
    const dir = tempDir();
    const path = join(dir, 'collision.json');
    withHome(dir);
    vi.stubEnv('ZAI_API_KEY', 'FAKE_GLM_SENTINEL');
    // A prior interrupted run can leave the isolated dir behind with no recorded account.
    mkdirSync(join(dir, '.heddle', 'accounts', 'claude', 'glm-1'), { recursive: true });
    const report: string[] = [];
    const summary = await runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'global', '', 'ZAI_API_KEY', 'paid', 'T2', false]),
      runner: fakeRunner, report: (line) => report.push(line),
    });
    expect(summary).toMatchObject({ added: [], failed: ['glm-1'] });
    expect(loadAccountRegistry(path).accounts).toEqual([]);
    expect(report.join('\n')).toContain('FAIL glm glm-1');
  });

  it('onboards Ollama without requiring a key and records its default local endpoint', async () => {
    const path = join(tempDir(), 'ollama.json');
    const home = tempDir();
    withHome(home);
    vi.stubEnv('OPENAI_API_KEY', undefined);

    const summary = await runAccountsAdd({ provider: 'ollama', registryPath: path, homeDir: home }, {
      prompter: new ScriptedPrompter([true, '', '', false]), runner: fakeRunner,
    });

    const account = loadAccountRegistry(path).accounts[0]!;
    expect(summary.added).toEqual(['ollama-1']);
    expect(account).toMatchObject({
      id: 'ollama-1', provider: 'codex', harness: 'codex-cli', billingClass: 'free-tier', tier: 'T0',
      credentialRef: `codex:ollama:${account.codexHome}`,
      envRepoint: { baseUrl: 'http://localhost:11434/v1', authTokenRef: 'OPENAI_API_KEY', service: 'ollama' },
    });
    expect(account.trainsOnInputs).toBeUndefined();
  });

  it('records an overridden LM Studio local endpoint', async () => {
    const path = join(tempDir(), 'lmstudio.json');
    withHome(tempDir());
    const baseUrl = 'http://127.0.0.1:4567/v1';

    const summary = await runAccountsAdd({ provider: 'lmstudio', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', baseUrl, false]), runner: fakeRunner,
    });

    expect(summary.added).toEqual(['lmstudio-1']);
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      envRepoint: { baseUrl, authTokenRef: 'OPENAI_API_KEY', service: 'lmstudio' },
      billingClass: 'free-tier', tier: 'T0',
    });
  });

  it('fails a local-runtime id collision without replacing the existing codex account', async () => {
    const path = join(tempDir(), 'ollama-collision.json');
    withHome(tempDir());
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      codex: [{ id: 'shared', codexHome: '/tmp/native-codex', billingClass: 'subscription-quota', tier: 'T1', loggedIn: true }],
    }));
    const report: string[] = [];

    const prompter = new RecordingPrompter(new ScriptedPrompter([true, 'shared', false]));
    const summary = await runAccountsAdd({ provider: 'ollama', registryPath: path }, {
      prompter, runner: fakeRunner, report: (line) => report.push(line),
    });

    expect(summary).toMatchObject({ added: [], failed: ['shared'] });
    expect(loadAccountRegistry(path).accounts).toMatchObject([{ id: 'shared', provider: 'codex', loggedIn: true }]);
    expect(report.join('\n')).toContain('already used by an existing codex account');
    expect(prompter.questions).toContain('Any other Ollama accounts to cycle through?');
  });

  it('offers local-runtime providers in the default wizard', async () => {
    const path = join(tempDir(), 'localruntime.json');
    withHome(tempDir());
    const prompter = new RecordingPrompter(new ScriptedPrompter(Array.from({ length: 16 }, () => false)));
    const summary = await runAccountsAdd({ registryPath: path }, { prompter, runner: fakeRunner });
    expect(prompter.questions).toContain('Do you have a Ollama account?');
    expect(prompter.questions).toContain('Do you have a LM Studio account?');
    expect(summary.added).toEqual([]);
  });

  it('refuses deferred browser-oauth provider surfaces via --provider', async () => {
    const path = join(tempDir(), 'deferred.json');
    withHome(tempDir());
    await expect(runAccountsAdd({ provider: 'gemini', registryPath: path }, {
      prompter: new ScriptedPrompter([]), runner: fakeRunner,
    })).rejects.toThrow(/does not yet support/i);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps region and endpoint consistent (GLM china does not default to the global URL)', async () => {
    const path = join(tempDir(), 'glm-china.json');
    withHome(tempDir());
    vi.stubEnv('ZAI_API_KEY', 'FAKE_GLM_SENTINEL');
    const cnUrl = 'https://open.bigmodel.cn/api/anthropic';
    // 'china' → the base-URL prompt has NO default, so the operator must supply the CN endpoint.
    const summary = await runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, '', 'china', cnUrl, 'ZAI_API_KEY', 'paid', 'T2', false]),
      runner: fakeRunner,
    });
    expect(summary.added).toEqual(['glm-1']);
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({ region: 'china', envRepoint: { baseUrl: cnUrl } });
  });

  it('does not clobber an existing native account whose id collides with an env-repoint id', async () => {
    const path = join(tempDir(), 'collide.json');
    withHome(tempDir());
    vi.stubEnv('ZAI_API_KEY', 'FAKE_GLM_SENTINEL');
    // A native Claude account already owns id 'claude-1'.
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      claude: [{ id: 'claude-1', configDir: '/tmp/native-claude-1', billingClass: 'subscription-quota', tier: 'T1', loggedIn: true }],
    }));
    const report: string[] = [];
    const summary = await runAccountsAdd({ provider: 'glm', registryPath: path }, {
      prompter: new ScriptedPrompter([true, 'claude-1', false]), runner: fakeRunner, report: (line) => report.push(line),
    });
    expect(summary).toMatchObject({ added: [], failed: ['claude-1'] });
    // The native account survives untouched — not replaced by the env-repoint upsert.
    const survivor = loadAccountRegistry(path).accounts.find((account) => account.id === 'claude-1')!;
    expect(survivor).toMatchObject({ provider: 'claude', loggedIn: true, configDir: '/tmp/native-claude-1' });
    expect(survivor.envRepoint).toBeUndefined();
    expect(report.join('\n')).toContain('already used by an existing claude account');
  });

  it('rejects a custom provider slug that collides with a matrix key', async () => {
    const path = join(tempDir(), 'custom.json');
    await expect(runAccountsAdd({ provider: 'custom', registryPath: path }, {
      prompter: new ScriptedPrompter(['GLM', 'openai-compatible']), runner: fakeRunner,
    })).rejects.toThrow(/collides with matrix provider key/i);
  });
});
