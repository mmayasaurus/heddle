import { readFileSync } from 'node:fs';
import type { BoundedAdmission } from './dispatcher/types.js';

export function readBoundedAdmissionFile(path: string): BoundedAdmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`--bounded-admission ${JSON.stringify(path)} could not be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--bounded-admission must contain an object');
  }
  const admission = parsed as Record<string, unknown>;
  const keys = ['requestId', 'sessionId', 'account', 'remainingTokens', 'observedAt'];
  const unknown = Object.keys(admission).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`--bounded-admission contains unknown field(s): ${unknown.join(', ')}`);
  if (!keys.every((key) => Object.hasOwn(admission, key))
      || typeof admission.requestId !== 'string' || !admission.requestId.trim()
      || typeof admission.sessionId !== 'string' || !admission.sessionId.trim()
      || typeof admission.account !== 'string' || !admission.account.trim()
      || typeof admission.remainingTokens !== 'number' || !Number.isInteger(admission.remainingTokens) || admission.remainingTokens < 0
      || typeof admission.observedAt !== 'string' || !admission.observedAt.trim()) {
    throw new Error('--bounded-admission must contain exactly non-empty requestId, sessionId, account, observedAt strings and a non-negative integer remainingTokens');
  }
  return admission as unknown as BoundedAdmission;
}
