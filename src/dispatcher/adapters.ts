import { AgyAdapter } from '../adapters/agy.js';
import { CodexAdapter } from '../adapters/codex.js';
import { CursorAdapter } from '../adapters/cursor.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { OpenAICompatAdapter } from '../adapters/openai-compat.js';
import { LocalAdapter } from '../adapters/local.js';
import { GeminiCliAdapter } from '../adapters/gemini-cli.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import type { WorkerAdapter } from '../types.js';

export function defaultAdapterFor(provider: string): WorkerAdapter {
  switch (provider) {
    case 'codex': return new CodexAdapter();
    case 'cursor': return new CursorAdapter();
    case 'gemini': return new AgyAdapter();
    case 'gemini-cli': return new GeminiCliAdapter();
    case 'opencode': return new OpenCodeAdapter();
    case 'claude': return new ClaudeAdapter();
    case 'groq': return new OpenAICompatAdapter('groq');
    case 'cerebras': return new OpenAICompatAdapter('cerebras');
    case 'openrouter': return new OpenAICompatAdapter('openrouter');
    case 'glm': return new OpenAICompatAdapter('glm');
    case 'local': return new LocalAdapter();
    default:
      throw new Error(`no adapter for provider "${provider}"`);
  }
}
