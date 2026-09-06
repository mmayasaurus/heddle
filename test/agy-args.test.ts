import { describe, it, expect } from 'vitest';
import { AgyAdapter } from '../src/adapters/agy.js';

describe('AgyAdapter.buildArgs — invocation contract', () => {
  it('builds the default gemini invocation with a print timeout inside its process budget', () => {
    expect(new AgyAdapter().buildArgs('do it', { model: 'gemini-3.6-flash-low', cwd: '/tmp' })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--print-timeout', '9m',
      '--dangerously-skip-permissions',
    ]);
  });

  it('formats a non-minute-aligned budget in seconds (the s branch)', () => {
    expect(new AgyAdapter().buildArgs('do it', {
      model: 'gemini-3.6-flash-low', cwd: '/tmp', timeoutMs: 300_000,
    })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--print-timeout', '270s',
      '--dangerously-skip-permissions',
    ]);
  });

  it('formats a sub-second remainder in milliseconds and never emits zero (the ms branch)', () => {
    expect(new AgyAdapter().buildArgs('do it', {
      model: 'gemini-3.6-flash-low', cwd: '/tmp', timeoutMs: 1_000,
    })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--print-timeout', '900ms',
      '--dangerously-skip-permissions',
    ]);
  });

  it('a probe-sized budget derives a print timeout inside the probe window (retry-args shape)', () => {
    expect(new AgyAdapter().buildArgs('do it', {
      model: 'gemini-3.6-flash-low', cwd: '/tmp', timeoutMs: 120_000,
    })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--print-timeout', '108s',
      '--dangerously-skip-permissions',
    ]);
  });

  it('a caller-supplied --print-timeout in extraFlags wins — no duplicate generated flag', () => {
    expect(new AgyAdapter().buildArgs('do it', {
      model: 'gemini-3.6-flash-low', cwd: '/tmp', extraFlags: ['--print-timeout', '5m'],
    })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--dangerously-skip-permissions',
      '--print-timeout', '5m',
    ]);
  });

  it('non-finite and non-positive budgets fall back to the default print timeout', () => {
    const argsFor = (timeoutMs: number) =>
      new AgyAdapter().buildArgs('do it', { model: 'gemini-3.6-flash-low', cwd: '/tmp', timeoutMs });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(argsFor(bad)).toContain('9m');
    }
  });

  it('derives the print timeout from a custom dispatch budget', () => {
    expect(new AgyAdapter().buildArgs('do it', {
      model: 'gemini-3.6-flash-low', cwd: '/tmp', timeoutMs: 720_000,
    })).toEqual([
      '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.6-flash-low',
      '--print-timeout', '11m',
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
      '--print-timeout', '9m',
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
