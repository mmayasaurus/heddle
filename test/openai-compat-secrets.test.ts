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

  test('regression: absent secrets keys and absent files do not invent environment-backed credentials', () => {
    const path = join(resources.tempDir(), 'secrets.env');
    writeFileSync(path, 'OTHER=value\n');
    expect(readSecretsEnvValue('GROQ_API_KEY', path)).toBeUndefined();
    expect(readSecretsEnvValue('GROQ_API_KEY', join(resources.tempDir(), 'missing.env'))).toBeUndefined();
  });
});
