import { AgyAdapter } from '../adapters/agy.js';
import { CodexAdapter } from '../adapters/codex.js';
import { CursorAdapter } from '../adapters/cursor.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { OpenAICompatAdapter } from '../adapters/openai-compat.js';
import type { WorkerAdapter } from '../types.js';

export function defaultAdapterFor(provider: string): WorkerAdapter {
  switch (provider) {
    case 'codex': return new CodexAdapter();
    case 'cursor': return new CursorAdapter();
    case 'gemini': return new AgyAdapter();
    case 'claude': return new ClaudeAdapter();
    case 'groq': return new OpenAICompatAdapter('groq');
    case 'cerebras': return new OpenAICompatAdapter('cerebras');
    case 'openrouter': return new OpenAICompatAdapter('openrouter');
    case 'glm': return new OpenAICompatAdapter('glm');
    default:
      throw new Error(`no adapter for provider "${provider}"`);
  }
}
