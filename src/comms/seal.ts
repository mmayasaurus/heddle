/**
 * In-process seal for broker tier decisions.
 *
 * A privileged tier (operator / orchestrator-directive) may only reach the log attached to a
 * decision object that the broker's own verifier produced. The seal is a module-private WeakSet
 * membership: it cannot be expressed in JSON, so nothing arriving over MCP, a socket or a file
 * can carry it, and a caller cannot fabricate `{ tier: 'operator', verified: true }` and have
 * the log accept it. (In-process code that imports this module is, by definition, inside the
 * trust boundary — the seal guards the API surface, not a hostile process.)
 */
const sealed = new WeakSet<object>();

/** Mark a decision as broker-issued. Only decideTier() should call this. */
export function seal<T extends object>(decision: T): T {
  sealed.add(decision);
  return decision;
}

export function isSealed(decision: unknown): decision is object {
  return typeof decision === 'object' && decision !== null && sealed.has(decision);
}
