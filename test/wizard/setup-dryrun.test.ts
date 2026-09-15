// HED-571: fresh-machine dry-run / validation harness for `heddle setup`. Drives the REAL wizard
// (`runSetup(ctx, io, buildSteps({ runner: fakeCliRunner }))`) on an ISOLATED temp HOME with a
// pattern-matching scripted prompter, and asserts HED-400 acceptance for the currently-wired step set
// (today: accounts). Y's test/wizard/setup.test.ts owns the orchestrator MECHANICS with synthetic steps;
// per its own note, "the full account/rules/etc. scenario matrix belongs to … W's HED-571 harness" — this.
//
// It grows as buildSteps wires more steps (model-economy/spread/meters/rules/doctor): the assertions
// iterate over buildSteps() output, and the headline "doctor green" bar lands when the doctor step wires
// in (HED-476). The harness sets process.env.HOME = temp from day 1 so it stays hermetic then, too — the
// doctor step verifies the REAL resolved env with no path overrides (T, msg 2094), so temp HOME is what
// keeps it (and its secret reads) off the tester's real ~/.heddle.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAccountRegistry } from '../../src/accounts.js';
import { buildSteps, runSetup, type SetupContext } from '../../src/wizard/setup.js';
import type { Prompter } from '../../src/wizard/prompt.js';
import type { CliRunner } from '../../src/wizard/cli-runner.js';
import type { ProbeResult } from '../../src/health/probe.js';
import type { WizardIO } from '../../src/wizard/step.js';

// ---- isolation: a fresh temp HOME per test, real env restored after -------------------------------
let tempHome: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'heddle-hed571-'));
  savedEnv = { ...process.env };
  // A faithful "fresh machine with only Claude Pro": relocate HOME and scrub anything that would
  // redirect a wizard write or fake a vendor login. The HEDDLE_ prefix is scrubbed WHOLESALE
  // (HEDDLE_ACCOUNTS is the load-bearing one — it repoints the registry path off temp HOME); if the
  // wizard ever grows a HEDDLE_ var it NEEDS present, set it explicitly in that scenario rather than
  // debugging a mystery empty-env failure here. (Vitest's default `forks` pool runs each test file in
  // its own process, so this env mutation cannot leak across files even before the afterEach restore.)
  process.env.HOME = tempHome;
  for (const key of Object.keys(process.env)) {
    if (/^(HEDDLE_|ANTHROPIC_|OPENAI_|CURSOR_|CLAUDE_|CODEX_|ZAI_|GLM_|QWEN_)/.test(key)) delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(tempHome, { recursive: true, force: true });
});

// ---- fakes ----------------------------------------------------------------------------------------
const loggedIn = (): ProbeResult => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0, timedOut: false });
const loggedOut = (): ProbeResult => ({ stdout: '{"loggedIn":false}', stderr: '', exitCode: 0, timedOut: false });

/** A CliRunner whose status() is scripted and whose login() is a no-op (no real vendor login under test). */
function fakeRunner(status: () => ProbeResult): CliRunner {
  return { login() { /* no-op */ }, status() { return status(); } };
}
/** A CliRunner that throws if touched — proves a scenario performed no login or status probe. */
function untouchableRunner(): CliRunner {
  return { login() { throw new Error('runner.login must not be called'); }, status() { throw new Error('runner.status must not be called'); } };
}

/**
 * Answer prompts by QUESTION PATTERN rather than by position. The account flow iterates every native
 * AND every env-repoint provider in the matrix, so the prompt COUNT grows with the matrix — a positional
 * ScriptedPrompter array would be brittle. Unmatched confirms default to `false` (decline), so a scenario
 * accepts only what it explicitly matches; unmatched selects take the first choice; unmatched text takes
 * the prompt's own default.
 */
interface Plan {
  confirmTrue?: RegExp[];
  selects?: { pattern: RegExp; choice: string }[];
  texts?: { pattern: RegExp; value: string }[];
}
class PlanPrompter implements Prompter {
  readonly asked: string[] = [];
  constructor(private readonly plan: Plan = {}) {}
  async text(question: string, defaultValue?: string): Promise<string> {
    this.asked.push(question);
    const match = this.plan.texts?.find((entry) => entry.pattern.test(question));
    return match ? match.value : defaultValue ?? '';
  }
  async select(question: string, choices: readonly string[]): Promise<string> {
    this.asked.push(question);
    const match = this.plan.selects?.find((entry) => entry.pattern.test(question));
    const choice = match ? match.choice : choices[0] ?? '';
    if (!choices.includes(choice)) throw new Error(`plan choice '${choice}' not in [${choices.join(', ')}] for: ${question}`);
    return choice;
  }
  async confirm(question: string): Promise<boolean> {
    this.asked.push(question);
    return this.plan.confirmTrue?.some((re) => re.test(question)) ?? false;
  }
  async secret(question: string): Promise<string> { this.asked.push(question); return ''; }
  close(): void { /* no handle */ }
}

// ---- helpers --------------------------------------------------------------------------------------
const ctx = (over: Partial<SetupContext> = {}): SetupContext => ({ homeDir: tempHome, now: () => new Date('2026-01-01T00:00:00Z'), ...over });

function makeIO(prompter: Prompter): WizardIO & { lines: string[] } {
  const lines: string[] = [];
  return { prompter, report: (line: string) => { lines.push(line); }, lines };
}

const registryPath = (): string => join(tempHome, '.heddle', 'accounts.json');
// Read through the shipped loader: on disk the registry is provider-keyed (`{schemaVersion, claude:[…]}`),
// which loadAccountRegistry flattens into `{ accounts: Account[] }` — assert against that canonical view.
const readRegistry = () => loadAccountRegistry(registryPath());
/** Every file under the temp home — for the no-secret scan (nothing outside temp home is written). */
function filesUnderHome(dir: string = tempHome): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnderHome(path));
    else out.push(path);
  }
  return out;
}

// =================================================================================================
describe('heddle setup — fresh-machine validation harness (HED-571)', () => {
  it('full-accept: logs in every native provider, writes the registry, all steps done', async () => {
    const prompter = new PlanPrompter({
      confirmTrue: [/Do you have a Claude account/, /Do you have a Codex account/, /Do you have a Cursor account/],
    });
    const results = await runSetup(ctx(), makeIO(prompter), buildSteps({ runner: fakeRunner(loggedIn) }));

    // Assert 'done' on a DELIBERATE known-id set — never a blanket `every step === 'done'` loop. The
    // read-only doctor step (HED-476) returns 'failed' on a bare temp HOME (no comms/routing/secrets to
    // verify), so a blanket loop would redden main the instant its owner adds `doctorStep` to buildSteps
    // — a test THIS PR owns breaking a teammate's disjoint one-line wire-in (the count-assertion
    // collision class). Expand `validated` deliberately as each step gains a hermetic seam + scripted
    // answers; doctor-green lands with createDoctorStep's DoctorDeps override (T, msg 2094).
    const validated = new Set(['accounts']);
    expect(results.map((result) => result.id)).toContain('accounts');
    for (const result of results) {
      // HED-400 #3 — every step echoes its outcome, never a silent empty default (wired or not yet).
      expect(result.summary.length, `${result.id} summary must be non-empty`).toBeGreaterThan(0);
      if (validated.has(result.id)) expect(result.status, `${result.id} → ${result.summary}`).toBe('done');
    }
    const registry = readRegistry();
    expect(registry.accounts.map((account) => account.provider).sort()).toEqual(['claude', 'codex', 'cursor']);
    expect(registry.accounts.every((account) => account.loggedIn === true)).toBe(true);
    // The accounts step reports the specific count it added (never a silent default).
    expect(results.find((result) => result.id === 'accounts')?.summary).toMatch(/3 added/);
  });

  it('minimal (HED-400 #2): accept Claude only, decline every other service → still a valid, done setup', async () => {
    const prompter = new PlanPrompter({ confirmTrue: [/Do you have a Claude account/] });
    const results = await runSetup(ctx(), makeIO(prompter), buildSteps({ runner: fakeRunner(loggedIn) }));

    expect(results.find((result) => result.id === 'accounts')?.status).toBe('done');
    const registry = readRegistry();
    expect(registry.accounts).toHaveLength(1);
    expect(registry.accounts[0]).toMatchObject({ provider: 'claude', loggedIn: true });
  });

  it('decline everything: no provider added → accounts step skipped, empty registry, runner untouched', async () => {
    // untouchableRunner throws if any login/status happens — declining must reach neither.
    const prompter = new PlanPrompter({});
    const results = await runSetup(ctx(), makeIO(prompter), buildSteps({ runner: untouchableRunner() }));

    expect(results.find((result) => result.id === 'accounts')?.status).toBe('skipped');
    expect(readRegistry().accounts).toHaveLength(0);
  });

  it('--dry-run: no prompts, no logins, no writes; accounts step skipped and reports what it would do', async () => {
    const prompter = new PlanPrompter({}); // .asked must stay empty
    const io = makeIO(prompter);
    const results = await runSetup(ctx({ dryRun: true }), io, buildSteps({ runner: untouchableRunner() }));

    const accounts = results.find((result) => result.id === 'accounts');
    expect(accounts?.status).toBe('skipped');
    expect(accounts?.summary.toLowerCase()).toContain('dry-run');
    expect(prompter.asked).toEqual([]); // never prompted
    expect(filesUnderHome()).toEqual([]); // nothing written under temp home
    expect(io.lines.join('\n')).toContain('Setup complete');
  });

  it('failed login is recorded failed (never a silent success): status → failed', async () => {
    const prompter = new PlanPrompter({ confirmTrue: [/Do you have a Claude account/] });
    const results = await runSetup(ctx(), makeIO(prompter), buildSteps({ runner: fakeRunner(loggedOut) }));

    const accounts = results.find((result) => result.id === 'accounts');
    expect(accounts?.status).toBe('failed');
    expect(accounts?.summary).toMatch(/failed/);
    expect(readRegistry().accounts[0]).toMatchObject({ provider: 'claude', loggedIn: false });
  });

  it('no secret leaks (HED-400 #1): a key referenced by env-var NAME never lands in the transcript or on disk', async () => {
    const SECRET_VALUE = 'sk-hed571-DO-NOT-LEAK-9f3a2b';
    process.env.HED571_SENTINEL_KEY = SECRET_VALUE;
    // Add a custom (env-repoint-style) provider — a matrix-independent flow that references an API key by
    // the NAME of an exported env var, never by value (the wizard only checks the var EXISTS).
    const prompter = new PlanPrompter({
      confirmTrue: [/Any provider\/key\/model not listed/],
      selects: [{ pattern: /API style/, choice: 'openai-compatible' }],
      texts: [
        { pattern: /display name/, value: 'HED571 Provider' },
        { pattern: /base URL/, value: 'https://api.example.com' },
        { pattern: /environment variable holds/, value: 'HED571_SENTINEL_KEY' },
        { pattern: /model IDs/, value: 'model-x' },
      ],
    });
    const io = makeIO(prompter);
    await runSetup(ctx(), io, buildSteps({ runner: untouchableRunner() }));

    const haystack = [io.lines.join('\n'), ...filesUnderHome().map((file) => readFileSync(file, 'utf8'))].join('\n');
    expect(haystack).not.toContain(SECRET_VALUE);           // the VALUE never appears anywhere
    expect(readFileSync(registryPath(), 'utf8')).toContain('HED571_SENTINEL_KEY'); // the NAME is what's stored
  });
});
