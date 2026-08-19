import { describe, it, expect } from 'vitest';
import { AgyAdapter } from '../src/adapters/agy.js';

describe('AgyAdapter.buildArgs — invocation contract', () => {
  it('builds the default gemini invocation (effort comes from the slug, no --effort)', () => {
    expect(new AgyAdapter().buildArgs('do it', { model: 'gemini-3.6-flash-low', cwd: '/tmp' })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--dangerously-skip-permissions',
    ]);
  });

  it('adds --conversation for resume', () => {
    const args = new AgyAdapter().buildArgs('x', { model: 'gemini-3.1-pro-high', cwd: '/tmp', resume: 'conv-9' });
    expect(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2)).toEqual(['--conversation', 'conv-9']);
  });

  it('composes resume + extraFlags and can disable permission-skip — exact argv', () => {
    const args = new AgyAdapter('agy', false).buildArgs('go', {
      model: 'gemini-3.6-flash-high', cwd: '/tmp', resume: 'c-1', extraFlags: ['--foo', 'bar'],
    });
    expect(args).toEqual([
      '-p', 'go', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-high',
      '--conversation', 'c-1', '--foo', 'bar',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('regression HED-28 — agy --effort must not be combined with an effort-suffixed slug', () => {
  // agy hard-errors: "invalid model selection (--model gemini-3.6-flash-low --effort high):
  // conflicts with --effort" (live-verified, agy 1.1.15, 2026-08-19). The catalog is entirely
  // effort-suffixed, so a dispatch that also sets opts.effort (e.g. via auto_effort) must NOT emit
  // --effort or every gemini worker with effort set would error out.
  it('omits --effort when the model slug already encodes effort (-low/-medium/-high)', () => {
    for (const model of ['gemini-3.6-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.1-pro-high']) {
      const args = new AgyAdapter().buildArgs('x', { model, cwd: '/tmp', effort: 'high' });
      expect(args).not.toContain('--effort');
    }
  });

  it('still passes --effort for an unsuffixed model id (forward-compat, no conflict)', () => {
    const args = new AgyAdapter().buildArgs('x', { model: 'gemini-9.9-flash', cwd: '/tmp', effort: 'medium' });
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'medium']);
  });
});
