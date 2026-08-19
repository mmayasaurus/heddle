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

describe('regression HED-28 — reconcile effort override with agy slug-suffix effort', () => {
  // agy hard-errors on a suffixed slug + --effort ("invalid model selection … conflicts with
  // --effort", live-verified agy 1.1.15, 2026-08-19). So an explicit opts.effort (e.g. via
  // auto_effort) must be HONORED by rewriting the slug suffix — NOT dropped (which would silently run
  // the routed effort and ignore the request; codeant/codex #59 P1) and NEVER emitted as --effort.
  const modelOf = (args: string[]) => args[args.indexOf('--model') + 1];

  it('honors an effort override by rewriting the slug suffix, and never emits --effort', () => {
    const hi = new AgyAdapter().buildArgs('x', { model: 'gemini-3.6-flash-low', cwd: '/tmp', effort: 'high' });
    expect(modelOf(hi)).toBe('gemini-3.6-flash-high');   // effort HONORED, not the routed -low
    expect(hi).not.toContain('--effort');
    const lo = new AgyAdapter().buildArgs('x', { model: 'gemini-3.1-pro-high', cwd: '/tmp', effort: 'low' });
    expect(modelOf(lo)).toBe('gemini-3.1-pro-low');
    expect(lo).not.toContain('--effort');
  });

  it('leaves the routed slug untouched when no effort override is set', () => {
    const args = new AgyAdapter().buildArgs('x', { model: 'gemini-3.6-flash-low', cwd: '/tmp' });
    expect(modelOf(args)).toBe('gemini-3.6-flash-low');
    expect(args).not.toContain('--effort');
  });

  it('leaves a suffixed slug untouched for a non-gemini level (e.g. codex xhigh) — can\'t honor, don\'t error', () => {
    const args = new AgyAdapter().buildArgs('x', { model: 'gemini-3.6-flash-medium', cwd: '/tmp', effort: 'xhigh' });
    expect(modelOf(args)).toBe('gemini-3.6-flash-medium');
    expect(args).not.toContain('--effort');
  });

  it('passes --effort for an unsuffixed model id (forward-compat, no conflict)', () => {
    const args = new AgyAdapter().buildArgs('x', { model: 'gemini-9.9-flash', cwd: '/tmp', effort: 'medium' });
    expect(modelOf(args)).toBe('gemini-9.9-flash');
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'medium']);
  });
});
