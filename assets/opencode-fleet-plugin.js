// Heddle managed native integration. Paths are filled by init-client.
import { execFileSync } from 'node:child_process';

export const HeddleFleet = async ({ client, directory }) => {
  const invoke = (event, payload) => {
    try {
      return JSON.parse(execFileSync(__HEDDLE_NODE__, [__HEDDLE_HOOK__, 'opencode', event, directory, __HEDDLE_AGENT__],
        { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch { return {}; } // same fail-open posture as the ratified Heddle rules engine
  };
  const started = new Set();
  const continuing = new Set();
  const completed = new Set();
  return {
    'chat.message': async (input, output) => {
      try {
        const event = started.has(input.sessionID) ? 'UserPromptSubmit' : 'SessionStart';
        started.add(input.sessionID);
        completed.delete(input.sessionID);
        const result = invoke(event, { session_id: input.sessionID });
        const text = output.parts.find((part) => part.type === 'text');
        if (text && result.context) text.text += '\n\n' + result.context;
      } catch { /* preserve the original prompt if context injection is unavailable */ }
    },
    'tool.execute.before': async (input, output) => {
      const result = invoke('PreToolUse', { session_id: input.sessionID, tool_name: input.tool, tool_input: output.args });
      if (result.deny) throw new Error(result.deny);
    },
    'tool.execute.after': async (input, output) => {
      try {
        const result = invoke('PostToolUse', { session_id: input.sessionID, tool_name: input.tool, tool_input: input.args });
        if (result.context) output.output += '\n\n' + result.context;
      } catch { /* keep the original tool result */ }
    },
    event: async ({ event }) => {
      const id = event.properties?.sessionID;
      if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (info?.role === 'assistant' && info.finish === 'stop' && !info.error) completed.add(info.sessionID);
        return;
      }
      if (event.type === 'session.error' || event.type === 'session.deleted') {
        completed.delete(id);
        started.delete(id);
        return;
      }
      if (event.type !== 'session.idle' || !id || !started.has(id) || !completed.delete(id) || continuing.has(id)) return;
      continuing.add(id);
      try {
        const result = invoke('Stop', { session_id: id });
        if (result.context) await client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text: result.context }] } });
      } catch { /* durable inbox remains available through MCP */ }
      finally { continuing.delete(id); }
    },
  };
};
