import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';

describe('CodexAdapter.buildArgs — invocation contract', () => {
  it('builds the default-deny invocation exactly', () => {
    expect(new CodexAdapter().buildArgs('do it', { model: 'gpt-5.6-luna', cwd: '/tmp' })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c',
      'approval_policy="never"', '--ignore-user-config', '-m', 'gpt-5.6-luna', 'do it',
    ]);
  });

  it('adds codex-enforceable network and browse capability pairs', () => {
    const args = new CodexAdapter().buildArgs('do it', { model: 'm', cwd: '/tmp', capabilities: ['net', 'browse'] });
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args.slice(args.indexOf('sandbox_workspace_write.network_access=true') - 1,
      args.indexOf('sandbox_workspace_write.network_access=true') + 1)).toEqual(['-c', 'sandbox_workspace_write.network_access=true']);
    expect(args.slice(args.indexOf('web_search="live"') - 1, args.indexOf('web_search="live"') + 1)).toEqual(['-c', 'web_search="live"']);
  });

  it('widens only the sandbox when exec-privileged is granted', () => {
    const args = new CodexAdapter().buildArgs('do it', { model: 'm', cwd: '/tmp', capabilities: ['exec-privileged'] });
    expect(args).toContain('danger-full-access');
    expect(args).not.toContain('workspace-write');
  });

  it('orders effort resume and extra flags according to the codex invocation contract', () => {
    const args = new CodexAdapter().buildArgs('do it', {
      model: 'm', cwd: '/tmp', effort: 'high', resume: 'thr-1', extraFlags: ['--foo'],
    });
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.indexOf('resume')).toBeLessThan(args.indexOf('-m'));
    expect(args.slice(args.indexOf('-m'))).toEqual(['-m', 'm', '--foo', 'do it']);
    const custom = new CodexAdapter('codex', 'read-only', false).buildArgs('do it', { model: 'm', cwd: '/tmp' });
    expect(custom[custom.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(custom).not.toContain('--ignore-user-config');
  });

  it('does not include any capability-widening flags by default', () => {
    const args = new CodexAdapter().buildArgs('do it', { model: 'm', cwd: '/tmp' }).join(' ');
    expect(args).not.toContain('danger-full-access');
    expect(args).not.toContain('network_access');
    expect(args).not.toContain('web_search');
  });
});
