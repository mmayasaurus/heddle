import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readSecretsEnvValue } from '../src/adapters/openai-compat.js';
import { useTempResources } from './helpers.js';

const resources = useTempResources('heddle-secrets-');

describe('readSecretsEnvValue', () => {
  test('regression: secrets parser preserves plain and quoted values while ignoring blank and commented lines', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(path, '# comment\n\nPLAIN=plain-value\nSINGLE=\'single value\'\nDOUBLE="double value"\n');
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
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fakefakefakefake');
    writeFileSync(path, 'GROQ_API_KEY=fakefakefakefake # note\n');
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fakefakefakefake');
    writeFileSync(path, 'GROQ_API_KEY="fake#fake" # note\n');
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fake#fake');
    writeFileSync(path, 'GROQ_API_KEY=fake#fake\n');
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBe('fake#fake');
    writeFileSync(path, "GROQ_API_KEY='' # empty\n");
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBeUndefined();
  });

  test('regression: absent secrets keys and absent files do not invent environment-backed credentials', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(path, 'OTHER=value\n');
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
});
