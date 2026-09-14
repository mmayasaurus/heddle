import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHooksChoose } from '../../src/wizard/hooks-choose.js';
import type { Prompter } from '../../src/wizard/prompt.js';
import { useTempResources } from '../helpers.js';

const payloads = [
  { name: 'synthetic match', payload: { hook_event_name: 'PreToolUse', tool_name: 'SyntheticShell' }, expect: { outcome: 'nudge' } },
  { name: 'synthetic non-match', payload: { hook_event_name: 'PreToolUse', tool_name: 'SyntheticEditor' }, expect: { outcome: 'none' } },
];

function seedCatalog(root: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const [id, action, enforce] of [['synthetic-block', 'block', true], ['synthetic-nudge', 'nudge', false]] as const) {
    writeFileSync(join(root, `${id}.yaml`), `id: ${id}\nevent: PreToolUse\nmatch:\n  tool: SyntheticShell\naction: ${action}\nenforce: ${enforce}\nsubagent_aware: false\nmessage: synthetic ${action} guidance\nfail_open: true\n`);
    writeFileSync(join(root, 'tests', `${id}.jsonl`), `${payloads.map(JSON.stringify).join('\n')}\n`);
  }
}

class TranscriptPrompter implements Prompter {
  readonly transcript: string[] = [];
  constructor(private readonly answers: boolean[]) {}
  async text(): Promise<string> { throw new Error('text was not expected'); }
  async select(): Promise<string> { throw new Error('select was not expected'); }
  async secret(): Promise<string> { throw new Error('secret was not expected'); }
  async confirm(question: string): Promise<boolean> {
    this.transcript.push(`confirm:${question}`);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('answer script exhausted');
    return answer;
  }
  close(): void {}
}

describe('runHooksChoose', () => {
  const { tempDir } = useTempResources('heddle-hooks-choose-');

  it('reports an empty catalog without throwing', async () => {
    const lines: string[] = [];
    await expect(runHooksChoose({ catalogRoot: tempDir() }, { prompter: new TranscriptPrompter([]), report: (line) => lines.push(line) }))
      .resolves.toEqual({ selected: [] });
    expect(lines).toContain('no hook-rules available');
  });

  it('shows every preview before the include decision and keeps a block unenforced when declined', async () => {
    const root = tempDir(); seedCatalog(root);
    const prompter = new TranscriptPrompter([true, false, false]);
    const transcript = prompter.transcript;
    const result = await runHooksChoose({ catalogRoot: root }, { prompter, report: (line) => transcript.push(`report:${line}`) });

    expect(result).toEqual({ selected: [{ id: 'synthetic-block', enforce: false }] });
    expect(transcript.filter((line) => line.includes('WOULD MATCH → NUDGE'))).toHaveLength(2);
    expect(transcript.filter((line) => line.includes('would not match'))).toHaveLength(3);
    expect(transcript.findIndex((line) => line.includes('WOULD MATCH'))).toBeLessThan(transcript.findIndex((line) => line.includes('include synthetic-block')));
    expect(transcript).toContain('confirm:enable ENFORCEMENT for synthetic-block? this will DENY matching tool calls, not just warn.');
  });

  it('requires the distinct enforcement confirmation to enable a block', async () => {
    const root = tempDir(); seedCatalog(root);
    const result = await runHooksChoose({ catalogRoot: root }, { prompter: new TranscriptPrompter([true, true, false]) });
    expect(result).toEqual({ selected: [{ id: 'synthetic-block', enforce: true }] });
  });
});
