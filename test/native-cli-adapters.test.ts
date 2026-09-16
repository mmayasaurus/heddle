import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiCliAdapter } from '../src/adapters/gemini-cli.js';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { useTempResources } from './helpers.js';

function executable(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

describe('native Gemini CLI adapter', () => {
  const { tempDir } = useTempResources('heddle-gemini-cli-adapter-');

  it('builds the official headless argv, including MCP allowlist and resume', () => {
    const args = new GeminiCliAdapter().buildArgs('do work', {
      model: 'gemini-3.1-pro-preview', cwd: '/tmp', resume: 'gem-session',
      readOnly: true, mcpServers: ['memtrace'], extraFlags: ['--screen-reader'],
    });
    expect(args).toEqual([
      '--output-format', 'stream-json', '--approval-mode', 'plan', '--model', 'gemini-3.1-pro-preview',
      '--resume', 'gem-session', '--allowed-mcp-server-names', 'memtrace', '--screen-reader', '--prompt', 'do work',
    ]);
  });

  it('parses a complete result, normalizes tokens, and forwards worker identity', async () => {
    const dir = tempDir();
    const bin = executable(dir, 'gemini-fake', `
const marker = process.env.HEDDLE_PARENT || 'missing';
console.log(JSON.stringify({type:'init',session_id:'gem-session',model:'gemini-3.1-pro-preview'}));
console.log(JSON.stringify({type:'message',role:'assistant',content:marker,delta:true}));
console.log(JSON.stringify({type:'result',status:'success',stats:{input_tokens:12,output_tokens:5,cached:3,duration_ms:41}}));
`);
    const result = await new GeminiCliAdapter(bin).dispatch('work', {
      model: 'gemini-3.1-pro-preview', cwd: dir, env: { HEDDLE_PARENT: 'codex-E' },
    });
    expect(result).toMatchObject({
      ok: true, output: 'codex-E', sessionId: 'gem-session', exitCode: 0, durationMs: 41,
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 },
    });
  });

  it('rejects exit-zero false success, fatal events, incomplete streams, and model fallback', async () => {
    const dir = tempDir();
    const cases = [
      [`console.log(JSON.stringify({type:'init',session_id:'s',model:'gemini-3.1-pro-preview'})); console.log(JSON.stringify({type:'result',status:'success',stats:{}}));`, /no assistant output/],
      [`console.log(JSON.stringify({type:'init',session_id:'s',model:'gemini-3.1-pro-preview'})); console.log(JSON.stringify({type:'message',role:'assistant',content:'partial',delta:true})); console.log(JSON.stringify({type:'error',severity:'error',message:'turn limit'})); console.log(JSON.stringify({type:'result',status:'success',stats:{}}));`, /turn limit/],
      [`console.log(JSON.stringify({type:'init',session_id:'s',model:'gemini-3.1-pro-preview'})); console.log(JSON.stringify({type:'message',role:'assistant',content:'partial',delta:true}));`, /no terminal result/],
      [`console.log(JSON.stringify({type:'init',session_id:'s',model:'gemini-3.1-flash'})); console.log(JSON.stringify({type:'message',role:'assistant',content:'answer',delta:true})); console.log(JSON.stringify({type:'result',status:'success',stats:{}}));`, /model fallback/],
    ] as const;
    for (let i = 0; i < cases.length; i++) {
      const result = await new GeminiCliAdapter(executable(dir, `gemini-false-${i}`, cases[i][0])).dispatch('work', {
        model: 'gemini-3.1-pro-preview', cwd: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(cases[i][1]);
      if (i === 2) expect(result.incomplete).toBe(true);
    }
  });
});

describe('native OpenCode adapter', () => {
  const { tempDir } = useTempResources('heddle-opencode-adapter-');

  it('builds run JSON argv with provider/model, variant, resume, and permission posture', () => {
    const args = new OpenCodeAdapter().buildArgs('do work', {
      model: 'opencode/nemotron-3-ultra-free', cwd: '/tmp', effort: 'high', resume: 'ses_123',
      extraFlags: ['--pure'],
    });
    expect(args).toEqual([
      'run', '--format', 'json', '--model', 'opencode/nemotron-3-ultra-free', '--variant', 'high',
      '--session', 'ses_123', '--dangerously-skip-permissions', '--pure', 'do work',
    ]);
    expect(new OpenCodeAdapter().buildArgs('review', {
      model: 'opencode/nemotron-3-ultra-free', cwd: '/tmp', readOnly: true,
    })).not.toContain('--dangerously-skip-permissions');
  });

  it('parses the final text and terminal step, sums usage, and forwards worker identity', async () => {
    const dir = tempDir();
    const bin = executable(dir, 'opencode-fake', `
const s='ses_native';
console.log(JSON.stringify({type:'step_start',sessionID:s,part:{type:'step-start'}}));
console.log(JSON.stringify({type:'text',sessionID:s,part:{type:'text',text:'progress'}}));
console.log(JSON.stringify({type:'step_finish',sessionID:s,part:{type:'step-finish',reason:'tool-calls',tokens:{input:10,output:2,reasoning:1,cache:{read:4,write:3}}}}));
console.log(JSON.stringify({type:'text',sessionID:s,part:{type:'text',text:process.env.HEDDLE_PARENT || 'missing'}}));
console.log(JSON.stringify({type:'step_finish',sessionID:s,part:{type:'step-finish',reason:'stop',tokens:{input:5,output:4,reasoning:2,cache:{read:6,write:0}}}}));
`);
    const result = await new OpenCodeAdapter(bin).dispatch('work', {
      model: 'opencode/nemotron-3-ultra-free', cwd: dir, env: { HEDDLE_PARENT: 'codex-E' },
    });
    expect(result).toMatchObject({
      ok: true, output: 'codex-E', sessionId: 'ses_native', exitCode: 0,
      usage: {
        inputTokens: 28, cachedInputTokens: 10, cacheCreationInputTokens: 3,
        outputTokens: 9, reasoningOutputTokens: 3,
      },
    });
  });

  it('rejects exit-zero false success, explicit errors, incomplete streams, and length finishes', async () => {
    const dir = tempDir();
    const cases = [
      [`console.log(JSON.stringify({type:'step_finish',sessionID:'s',part:{type:'step-finish',reason:'stop',tokens:{input:1,output:0,reasoning:0,cache:{read:0,write:0}}}}));`, /no assistant output/],
      [`console.log(JSON.stringify({type:'error',sessionID:'s',error:{name:'ProviderError',data:{message:'boom'}}}));`, /boom/],
      [`console.log(JSON.stringify({type:'text',sessionID:'s',part:{type:'text',text:'partial'}}));`, /no terminal step_finish/],
      [`console.log(JSON.stringify({type:'text',sessionID:'s',part:{type:'text',text:'partial'}})); console.log(JSON.stringify({type:'step_finish',sessionID:'s',part:{type:'step-finish',reason:'length',tokens:{input:1,output:2,reasoning:0,cache:{read:0,write:0}}}}));`, /finish reason=length/],
    ] as const;
    for (let i = 0; i < cases.length; i++) {
      const result = await new OpenCodeAdapter(executable(dir, `opencode-false-${i}`, cases[i][0])).dispatch('work', {
        model: 'opencode/nemotron-3-ultra-free', cwd: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(cases[i][1]);
      if (i >= 2) expect(result.incomplete).toBe(true);
      if (i === 3) expect(result.truncated).toBe(true);
    }
  });
});
