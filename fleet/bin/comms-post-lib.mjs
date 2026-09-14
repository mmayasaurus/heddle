// Shape gate only: no address syntax (rooms `#`, broadcast `@`, children `X.1`, operator word). The
// positive list is the registry (linear-agents.json), so a new fleet key shape needs no code change.
const validAgentKey = /^[A-Za-z0-9-]+$/;
const reservedWords = new Set(['operator', 'all', 'fleet']);

export function validateArgs(argv, agentsMap) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--to', '--kind', '--issue', '--body'].includes(arg) || index + 1 >= argv.length) {
      return { ok: false, error: 'Usage: comms-post.mjs --to <KEY> --kind <KIND> --issue <IDENTIFIER> --body <TEXT>' };
    }
    values[arg.slice(2)] = argv[++index];
  }
  if (!values.to || !values.kind || !values.issue || !values.body) {
    return { ok: false, error: 'Usage: comms-post.mjs --to <KEY> --kind <KIND> --issue <IDENTIFIER> --body <TEXT>' };
  }
  if (values.kind !== 'chat') return { ok: false, error: 'comms-post: --kind must be chat' };
  if (!validAgentKey.test(values.to) || reservedWords.has(values.to.toLowerCase())) {
    return { ok: false, error: `comms-post: --to must be a fleet agent key, not ${JSON.stringify(values.to)}` };
  }
  if (!agentsMap || !Object.prototype.hasOwnProperty.call(agentsMap, values.to)) {
    return { ok: false, error: `comms-post: --to ${JSON.stringify(values.to)} is not a configured fleet agent key` };
  }
  if (!values.body.startsWith('[linear-comment-watch]')) values.body = `[linear-comment-watch] ${values.body}`;
  return { ok: true, values };
}

export function classifyResult(result) {
  if (result.code === 'no-live-session') return { deliverable: true, outcome: 'logged-for-pull' };
  if (result.outcome === 'refused' || result.outcome === 'failed') {
    return { deliverable: false, error: `${result.code}: ${result.reason ?? 'broker did not accept the message'}` };
  }
  return { deliverable: true, outcome: result.code === 'queued-for-channel' ? 'queued-for-channel' : 'sent' };
}
