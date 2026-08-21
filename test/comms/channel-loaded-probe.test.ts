import { describe, expect, it } from 'vitest';
import { channelLoadedFromParentArgv } from '../../src/comms/channel-loaded-probe.js';

describe('channelLoadedFromParentArgv', () => {
  it('recognizes Claude launched with the heddle-comms channel flag', () => {
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels server:heddle-comms')).toBe(true);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels=server:heddle-comms')).toBe(true);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels plugin:preview-heddle-comms')).toBe(true);
  });

  it('reports false only for a clear Claude invocation without the heddle-comms channel flag', () => {
    expect(channelLoadedFromParentArgv(1, () => 'claude --print hello')).toBe(false);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels server:other-channel')).toBe(false);
  });

  it('returns unknown for absent, non-Claude, and unreadable parent argv', () => {
    expect(channelLoadedFromParentArgv(1, () => null)).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => '')).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => 'node dist/comms/channel-server.js')).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => { throw new Error('unavailable'); })).toBeNull();
  });
});
