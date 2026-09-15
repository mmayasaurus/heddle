import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedAdmissionFile } from '../src/bounded-admission.js';
import { useTempResources } from './helpers.js';

describe('readBoundedAdmissionFile', () => {
  const { tempDir } = useTempResources('heddle-bounded-admission-');

  it('accepts exactly the bounded admission schema', () => {
    const path = join(tempDir(), 'admission.json');
    writeFileSync(path, JSON.stringify({ requestId: 'r', sessionId: 's', account: 'a', remainingTokens: 0, observedAt: '2026-09-15T16:00:00Z' }));
    expect(readBoundedAdmissionFile(path)).toEqual({ requestId: 'r', sessionId: 's', account: 'a', remainingTokens: 0, observedAt: '2026-09-15T16:00:00Z' });
  });

  it('rejects unknown fields and invalid shapes', () => {
    const path = join(tempDir(), 'invalid.json');
    writeFileSync(path, JSON.stringify({ requestId: 'r', sessionId: 's', account: 'a', remainingTokens: 1, observedAt: 'now', typo: true }));
    expect(() => readBoundedAdmissionFile(path)).toThrow('unknown field');
  });
});
