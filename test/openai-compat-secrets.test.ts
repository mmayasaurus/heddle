import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readSecretsEnvValue } from '../src/adapters/openai-compat.js';
import { useTempResources } from './helpers.js';

const resources = useTempResources('heddle-secrets-');

afterEach(() => {
  vi.doUnmock('../src/secure-fs.js');
  vi.resetModules();
});

describe('readSecretsEnvValue', () => {
  test('regression: secrets parser preserves plain and quoted values while ignoring blank and commented lines', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(path, '# comment\n\nPLAIN=plain-value\nSINGLE=\'single value\'\nDOUBLE="double value"\n');
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('PLAIN', path)).toBe('plain-value');
    expect(readSecretsEnvValue('SINGLE', path)).toBe('single value');
    expect(readSecretsEnvValue('DOUBLE', path)).toBe('double value');
  });

  test('regression: secrets parser supports dotenv exports, trailing comments, and literal hashes', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(
      path,
      "export GROQ_API_KEY=fakefakefakefake\n"
        + 'GROQ_API_KEY=fakefakefakefake # note\n'
        + 'GROQ_API_KEY="fake#fake" # note\n'
        + 'GROQ_API_KEY=fake#fake\n'
        + "GROQ_API_KEY='' # empty\n",
    );
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fakefakefakefake');
    writeFileSync(path, 'GROQ_API_KEY=fakefakefakefake # note\n');
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fakefakefakefake');
    writeFileSync(path, 'GROQ_API_KEY="fake#fake" # note\n');
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fake#fake');
    writeFileSync(path, 'GROQ_API_KEY=fake#fake\n');
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fake#fake');
    writeFileSync(path, "GROQ_API_KEY='' # empty\n");
    chmodSync(path, 0o600);
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBeUndefined();
  });

  test('regression: absent secrets keys and absent files do not invent environment-backed credentials', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(path, 'OTHER=value\n');
    chmodSync(path, 0o600);
    const original = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'fakefakefakefake';
    try {
      expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBeUndefined();
      expect(readSecretsEnvValue('GROQ_API_KEY', join(resources.tempDir(), 'missing.env'))).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = original;
    }
  });

  test('refuses group or other-readable secrets files', () => {
    const path = join(resources.tempDir(), 'loose-perms.env');
    writeFileSync(path, 'GROQ_API_KEY=fakefakefakefake\n');
    chmodSync(path, 0o644);

    expect(() => readSecretsEnvValue('GROQ_API_KEY', path)).toThrow(/group or other permissions/);
  });

  test('refuses symlinked secrets files', () => {
    const target = join(resources.tempDir(), 'secrets-target.env');
    const link = join(resources.tempDir(), 'secrets-link.env');
    writeFileSync(target, 'GROQ_API_KEY=fakefakefakefake\n');
    chmodSync(target, 0o600);
    symlinkSync(target, link);

    expect(() => readSecretsEnvValue('GROQ_API_KEY', link)).toThrow(/symlink/);
  });

  test('returns a key from a secure secrets file', () => {
    const path = join(resources.tempDir(), 'secure.env');
    writeFileSync(path, 'GROQ_API_KEY=fakefakefakefake\n');
    chmodSync(path, 0o600);

    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fakefakefakefake');
  });

  test('dispatch reports insecure secrets files without making a request', async () => {
    vi.resetModules(); // ensure the doMock below is picked up even if this test runs in isolation
    vi.doMock('../src/secure-fs.js', () => ({
      secureReadFile: () => {
        throw new Error('refusing to read secret file /x: group or other permissions are present');
      },
    }));
    const { OpenAICompatAdapter } = await import('../src/adapters/openai-compat.js');
    const adapter = new OpenAICompatAdapter('groq');

    const result = await adapter.dispatch('x', { model: 'workhorse', timeoutMs: 1000 } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to use ~/.heddle/secrets.env');
  });
});
