import { describe, expect, it } from 'vitest';
import { loginIdentity } from '../src/health/parse.js';

describe('loginIdentity — claude auth status --json identity echo (HED-585)', () => {
  it('returns email · orgName · subscriptionType from the verified logged-in schema', () => {
    expect(loginIdentity(JSON.stringify({
      loggedIn: true, email: 'dev@example.com', orgId: 'o-1', orgName: 'Example Org', subscriptionType: 'max',
    }))).toBe('dev@example.com · Example Org · max');
  });

  it('includes only the fields the CLI reports (email alone when org/plan are absent)', () => {
    expect(loginIdentity(JSON.stringify({ loggedIn: true, email: 'solo@example.com' }))).toBe('solo@example.com');
  });

  it('never surfaces a non-identity field such as a token', () => {
    const out = loginIdentity(JSON.stringify({ email: 'dev@example.com', accessToken: 'token-MUST-NOT-APPEAR' }));
    expect(out).toBe('dev@example.com');
    expect(out).not.toContain('MUST-NOT-APPEAR');
  });

  it('returns undefined without an email (e.g. a not-logged-in probe)', () => {
    expect(loginIdentity(JSON.stringify({ loggedIn: false, authMethod: 'none' }))).toBeUndefined();
  });

  it('returns undefined for JSON null / a primitive / an array — never crashes on indexing (codacy)', () => {
    expect(loginIdentity('null')).toBeUndefined();
    expect(loginIdentity('42')).toBeUndefined();
    expect(loginIdentity('"a string"')).toBeUndefined();
    expect(loginIdentity('[1,2,3]')).toBeUndefined();
  });

  it('returns undefined for non-JSON output', () => {
    expect(loginIdentity('not json at all')).toBeUndefined();
  });
});
