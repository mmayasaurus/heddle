import { describe, it, expect } from 'vitest';
import { parseAddress, requireAddress, canSend, childAddress, OPERATOR, BROADCAST } from '../../src/comms/address.js';

describe('comms address grammar', () => {
  it('classifies every address form and extracts child lineage', () => {
    expect(parseAddress('K')).toEqual({ raw: 'K', kind: 'agent' });
    expect(parseAddress('codex-B')).toEqual({ raw: 'codex-B', kind: 'agent' });
    expect(parseAddress('3')).toEqual({ raw: '3', kind: 'agent' }); // fleet keys 1..6 are real identities
    expect(parseAddress('K.2')).toEqual({ raw: 'K.2', kind: 'child', parent: 'K', seq: 2 });
    expect(parseAddress('codex-B.14')).toEqual({ raw: 'codex-B.14', kind: 'child', parent: 'codex-B', seq: 14 });
    expect(parseAddress(OPERATOR)).toEqual({ raw: 'operator', kind: 'operator' });
    expect(parseAddress(BROADCAST)).toEqual({ raw: '@all', kind: 'broadcast' });
    expect(parseAddress('#fleet')).toEqual({ raw: '#fleet', kind: 'room' });
    expect(parseAddress('#hed-4')).toEqual({ raw: '#hed-4', kind: 'room' });
  });

  it('rejects malformed addresses instead of guessing', () => {
    for (const bad of ['', ' ', 'K.0', 'K.1.1', 'K.', '.1', '#', '# room', '@me', '@ALL', 'operator.1',
      'K L', 'K/1', 'a'.repeat(65), 'K.1234567890']) {
      expect(parseAddress(bad), bad).toBeNull();
    }
    expect(() => requireAddress('K.1.1', 'to')).toThrow(/invalid to address/);
    expect(() => requireAddress('', 'from')).toThrow(/invalid from address/);
  });

  it('is case-sensitive: fleet keys are exact identities, not spellings', () => {
    expect(parseAddress('k')?.raw).toBe('k');
    expect(parseAddress('k')).not.toEqual(parseAddress('K'));
  });

  it('only agents, children and the operator can send; rooms and @all only receive', () => {
    expect(canSend(parseAddress('K')!)).toBe(true);
    expect(canSend(parseAddress('K.1')!)).toBe(true);
    expect(canSend(parseAddress('operator')!)).toBe(true);
    expect(canSend(parseAddress('#fleet')!)).toBe(false);
    expect(canSend(parseAddress('@all')!)).toBe(false);
  });

  it('childAddress round-trips through parseAddress', () => {
    const addr = childAddress('R', 7);
    expect(addr).toBe('R.7');
    expect(parseAddress(addr)).toEqual({ raw: 'R.7', kind: 'child', parent: 'R', seq: 7 });
  });
});
