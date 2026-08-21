import { describe, expect, it } from 'vitest';
import { channelLoadedFromParentArgv } from '../../src/comms/channel-loaded-probe.js';

describe('channelLoadedFromParentArgv', () => {
  it('recognizes Claude launched with the heddle-comms channel flag', () => {
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels server:heddle-comms')).toBe(true);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels=server:heddle-comms')).toBe(true);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels plugin:heddle-comms@x')).toBe(true);
  });

  it('reports false only for a clear Claude invocation without the heddle-comms channel flag', () => {
    expect(channelLoadedFromParentArgv(1, () => 'claude --print hello')).toBe(false);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels server:other-channel')).toBe(false);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels server:other-heddle-comms')).toBe(false);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels heddle-comms-copy')).toBe(false);
  });

  it('treats valueless or mistyped channel flags as a clear missing channel', () => {
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels --foo')).toBe(false);
    expect(channelLoadedFromParentArgv(1, () => 'claude --dangerously-load-development-channels')).toBe(false);
  });

  it('returns unknown without inspecting an invalid parent pid', () => {
    expect(channelLoadedFromParentArgv(1.5, () => { throw new Error('should not read'); })).toBeNull();
  });

  it('returns unknown for absent, non-Claude, and unreadable parent argv', () => {
    expect(channelLoadedFromParentArgv(1, () => null)).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => '')).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => 'node dist/comms/channel-server.js')).toBeNull();
    expect(channelLoadedFromParentArgv(1, () => { throw new Error('unavailable'); })).toBeNull();
  });
});
