import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const savedHome = process.env.HOME;
const savedRouting = process.env.HEDDLE_ROUTING;

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRouting === undefined) delete process.env.HEDDLE_ROUTING;
  else process.env.HEDDLE_ROUTING = savedRouting;
  vi.resetModules();
});

describe('dispatch — insecure credential files and fallback (HED-638)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-security-fallback-test-');

  function fallbackRouting(dir: string): string {
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, `version: 0
policy: {structural_caps: {max_children_per_orchestrator: 8, in_flight_stale_after_ms: 10800000}}
providers:
  groq: {auth: api-key, execution: headless, models: [workhorse]}
  codex: {auth: chatgpt-subscription, execution: headless, models: [gpt-5.6-luna]}
task_classes:
  security-fallback:
    provider: groq
    model: workhorse
    fallback: {provider: codex, model: gpt-5.6-luna}
    read_only: false
    edits_code: false
`);
    return path;
  }

  it('short-circuits class fallback and records a warning when the primary credential file is insecure', async () => {
    const home = tempDir();
    const heddleDir = join(home, '.heddle');
    mkdirSync(heddleDir);
    const secretsPath = join(heddleDir, 'secrets.env');
    // No key=value line: secureReadFile rejects the 0o644 mode (next line) before any content is parsed,
    // so the fixture needs no secret-shaped content — and none is written (keeps scanners quiet).
    writeFileSync(secretsPath, '# an insecure-mode secrets.env fixture (group/other-readable)\n');
    chmodSync(secretsPath, 0o644);
    process.env.HOME = home;
    process.env.HEDDLE_ROUTING = fallbackRouting(tempDir());
    vi.resetModules();

    const [{ dispatch }, { OpenAICompatAdapter }] = await Promise.all([
      import('../src/dispatch.js'),
      import('../src/adapters/openai-compat.js'),
    ]);
    const fallback = fakeAdapter(undefined, { readAgents: false });
    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'security-fallback', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound },
      ledger,
      (provider) => provider === 'groq' ? new OpenAICompatAdapter('groq') : fallback.adapter,
    );

    expect(outcome).toMatchObject({ ok: false, provider: 'groq', usedFallback: false });
    expect(fallback.calls).toHaveLength(0);
    expect(outcome.error).toContain(`WARNING: insecure credential file ${secretsPath}`);
    expect(outcome.error).toContain('fallback suppressed for safety');
    expect(ledger.recent(1)[0].error).toContain(`WARNING: insecure credential file ${secretsPath}`);
  });

  it('escapes control characters in the credential path before the warning reaches the outcome or the ledger', async () => {
    const esc = String.fromCharCode(0x1b); // ESC — the lead byte of an ANSI/terminal escape sequence
    // A HOME whose name carries a raw ESC + ANSI-style payload; both the securityRefusal.file path and the
    // adapter's error message derive from it, so an un-escaped warning would inject a terminal sequence.
    const home = join(tempDir(), `pwn${esc}[31mHOME`);
    const heddleDir = join(home, '.heddle');
    mkdirSync(heddleDir, { recursive: true });
    const secretsPath = join(heddleDir, 'secrets.env');
    writeFileSync(secretsPath, '# an insecure-mode secrets.env fixture (group/other-readable)\n');
    chmodSync(secretsPath, 0o644);
    process.env.HOME = home;
    process.env.HEDDLE_ROUTING = fallbackRouting(tempDir());
    vi.resetModules();

    const [{ dispatch }, { OpenAICompatAdapter }] = await Promise.all([
      import('../src/dispatch.js'),
      import('../src/adapters/openai-compat.js'),
    ]);
    const fallback = fakeAdapter(undefined, { readAgents: false });
    const ledger = tempLedger();
    const outcome = await dispatch(
      { taskClass: 'security-fallback', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound },
      ledger,
      (provider) => provider === 'groq' ? new OpenAICompatAdapter('groq') : fallback.adapter,
    );

    // Security semantics unchanged by the escaping: the insecure primary still short-circuits the fallback.
    expect(outcome).toMatchObject({ ok: false, provider: 'groq', usedFallback: false });
    expect(fallback.calls).toHaveLength(0);
    // The raw ESC is gone from BOTH sinks (the returned error and the durable ledger row), replaced by its
    // visible \x1b escape — so neither a terminal nor a log reader is driven by the HOME-derived path.
    expect(outcome.error).toContain('\\x1b');
    expect(outcome.error).not.toContain(esc);
    const ledgerError = ledger.recent(1)[0].error ?? '';
    expect(ledgerError).toContain('\\x1b');
    expect(ledgerError).not.toContain(esc);
  });

  it('treats an ABSENT credential file as benign (ENOENT): no security marker, fallback not suppressed', async () => {
    // A HOME with NO .heddle/secrets.env at all → secureReadFile surfaces ENOENT → readSecretsEnvValue
    // returns undefined (key simply not configured). This is the fail-OPEN counterpart to the insecure
    // case above: an absent file is not a security boundary failure, so NO securityRefusal is set and the
    // safety short-circuit must not fire (codacy #239 — the ENOENT branch).
    const home = tempDir();
    process.env.HOME = home;
    process.env.HEDDLE_ROUTING = fallbackRouting(tempDir());
    vi.resetModules();

    const [{ dispatch }, { OpenAICompatAdapter }] = await Promise.all([
      import('../src/dispatch.js'),
      import('../src/adapters/openai-compat.js'),
    ]);
    const fallback = fakeAdapter({ ok: true, output: 'fallback result', exitCode: 0 }, { readAgents: false });
    const outcome = await dispatch(
      { taskClass: 'security-fallback', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound },
      tempLedger(),
      (provider) => provider === 'groq' ? new OpenAICompatAdapter('groq') : fallback.adapter,
    );

    // The security invariant: an absent file is NOT a security refusal, so the fallback is not suppressed
    // for safety (contrast the insecure-file test, which sets securityRefusal and suppresses).
    expect(outcome.securityRefusal).toBeUndefined();
    expect(outcome.error ?? '').not.toContain('fallback suppressed for safety');
    // And the missing key lets the class fall back to its configured secondary, like any benign primary miss.
    expect(outcome).toMatchObject({ usedFallback: true, provider: 'codex', ok: true });
    expect(fallback.calls).toHaveLength(1);
  });

  it('still falls back after an ordinary provider failure', async () => {
    process.env.HEDDLE_ROUTING = fallbackRouting(tempDir());
    const { dispatch } = await import('../src/dispatch.js');
    const primary = fakeAdapter({ ok: false, output: '', exitCode: 1, error: 'provider unavailable' }, { readAgents: false });
    const fallback = fakeAdapter({ ok: true, output: 'fallback result', exitCode: 0 }, { readAgents: false });

    const outcome = await dispatch(
      { taskClass: 'security-fallback', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound },
      tempLedger(),
      (provider) => provider === 'groq' ? primary.adapter : fallback.adapter,
    );

    expect(outcome).toMatchObject({ ok: true, provider: 'codex', output: 'fallback result', usedFallback: true });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });
});
