import { describe, it, expect, afterEach } from 'vitest';
import { buildWorkerEnv } from '../src/env.js';
import { WORKER_ENV } from '../src/identity.js';

// buildWorkerEnv reads process.env directly, so tests mutate it and restore afterward.
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('buildWorkerEnv — subscription-billing worker isolation (HED-30 allowlist)', () => {
  describe('inherited base env → vendor-namespace strip', () => {
    it('strips every vendor credential/billing namespace — including a NOVEL var — but keeps PATH/HOME', () => {
      process.env.ANTHROPIC_BASE_URL = 'http://evil';
      process.env.ANTHROPIC_CUSTOM_HEADERS = 'x';
      process.env.OPENAI_BASE_URL = 'http://evil';
      process.env.OPENAI_ORGANIZATION = 'org';
      process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      process.env.GOOGLE_CLOUD_PROJECT = 'p';
      process.env.VERTEXAI_PROJECT = 'p';
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'x';
      process.env.CURSOR_BASE_URL = 'http://evil';
      process.env.GEMINI_BASE_URL = 'http://evil';           // GEMINI_ prefix
      process.env.GCLOUD_ACCESS_TOKEN = 'x';                 // GCLOUD_ prefix
      process.env.CLAUDE_CODE_USE_NEW_BACKEND = 'true';      // CLAUDE_CODE_USE_ prefix
      process.env.ANTHROPIC_SOMETHING_BRAND_NEW = 'x'; // future var the exact denylist never listed
      process.env.CODEX_API_KEY = 'x';                  // explicit list (no bare CODEX_ prefix — CODEX_HOME is a selector)
      process.env.PATH = '/usr/bin';
      process.env.HOME = '/home/x';
      const { env, stripped } = buildWorkerEnv();
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_BASE_URL',
        'OPENAI_ORGANIZATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'VERTEXAI_PROJECT',
        'AWS_BEARER_TOKEN_BEDROCK', 'CURSOR_BASE_URL', 'GEMINI_BASE_URL', 'GCLOUD_ACCESS_TOKEN',
        'CLAUDE_CODE_USE_NEW_BACKEND', 'ANTHROPIC_SOMETHING_BRAND_NEW', 'CODEX_API_KEY']) {
        expect(env[k], `${k} must be stripped`).toBeUndefined();
        expect(stripped).toContain(k);
      }
      expect(env.PATH).toBe('/usr/bin');
      expect(env.HOME).toBe('/home/x');
    });

    it('strips an inherited CLAUDE_CODE_OAUTH_TOKEN (would pin every worker to one account)', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'parent-token';
      const { env, stripped } = buildWorkerEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(stripped).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('does NOT strip the CLAUDE_CONFIG_DIR / CODEX_HOME selectors by prefix', () => {
      process.env.CLAUDE_CONFIG_DIR = '/parent/.claude';
      process.env.CODEX_HOME = '/parent/.codex';
      const { env } = buildWorkerEnv();
      expect(env.CLAUDE_CONFIG_DIR).toBe('/parent/.claude'); // CLAUDE_ != CLAUDE_CODE_USE_
      expect(env.CODEX_HOME).toBe('/parent/.codex');         // no CODEX_ prefix in the strip list
    });
  });

  describe('overrides → allowlist', () => {
    it('allows every account selector + worker stamp', () => {
      const { env } = buildWorkerEnv({ overrides: {
        CODEX_HOME: '/a', CLAUDE_CONFIG_DIR: '/b', CLAUDE_CODE_OAUTH_TOKEN: 't', CURSOR_API_KEY: 'k',
        HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: '42', HEDDLE_PARENT: 'U',
      } });
      expect(env.CODEX_HOME).toBe('/a');
      expect(env.CLAUDE_CONFIG_DIR).toBe('/b');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
      expect(env.CURSOR_API_KEY).toBe('k');
      expect(env.HEDDLE_WORKER).toBe('1');
      expect(env.HEDDLE_DISPATCH_ID).toBe('42');
      expect(env.HEDDLE_PARENT).toBe('U');
    });

    it('REFUSES a billing/endpoint switch override, with the account-selector hint', () => {
      expect(() => buildWorkerEnv({ overrides: { OPENAI_BASE_URL: 'http://evil' } }))
        .toThrow(/allow-listed[\s\S]*billing\/endpoint switch/);
      expect(() => buildWorkerEnv({ overrides: { ANTHROPIC_API_KEY: 'x' } })).toThrow(/allow-listed/);
    });

    it('REFUSES an arbitrary non-allowlisted override — no silent pass-through (the HED-30 hole)', () => {
      expect(() => buildWorkerEnv({ overrides: { FOO_BAR: 'x' } })).toThrow(/allow-listed/);
    });

    it('replaces a stale inherited selector with the override, never leaks it', () => {
      process.env.CURSOR_API_KEY = 'STALE-parent-key';
      const { env } = buildWorkerEnv({ overrides: { CURSOR_API_KEY: 'CHOSEN' } });
      expect(env.CURSOR_API_KEY).toBe('CHOSEN');
    });

    it('silently ignores a parent-identity override — never re-injects it', () => {
      const { env } = buildWorkerEnv({ overrides: { HEDDLE_AGENT: 'U', CODEX_HOME: '/a' } });
      expect(env.HEDDLE_AGENT).toBeUndefined();
      expect(env.CODEX_HOME).toBe('/a');
    });
  });

  describe('invariants', () => {
    it('unset wins last — an override cannot re-introduce a var the caller unset', () => {
      const { env } = buildWorkerEnv({ overrides: { CLAUDE_CONFIG_DIR: '/b' }, unset: ['CLAUDE_CONFIG_DIR'] });
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('the hardcoded stamp allowlist matches identity.WORKER_ENV (drift guard)', () => {
      expect([WORKER_ENV.WORKER, WORKER_ENV.DISPATCH_ID, WORKER_ENV.PARENT])
        .toEqual(['HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT']);
      const { env } = buildWorkerEnv({ overrides: {
        [WORKER_ENV.WORKER]: '1', [WORKER_ENV.DISPATCH_ID]: '9', [WORKER_ENV.PARENT]: 'U',
      } });
      expect(env[WORKER_ENV.WORKER]).toBe('1');
    });
  });
});
