/**
 * Address grammar — who a message is from / to.
 *
 *   agent      K · R · codex-B · 3            fleet identity (the L0 lin.sh / identity-hook key; digits are real keys)
 *   child      K.1 · K.2 · codex-B.4          minted by the broker for a worker/subagent of `K`
 *   operator   operator                       the human — a first-class address (SPEC §9/§10)
 *   room       #fleet · #hed-4                a shared channel (pull model; agents read it when they want)
 *   broadcast  @all                           guaranteed-delivery exception (fires a notification)
 *
 * Children are ONE level deep by design: workers cannot dispatch workers (ROADMAP "structural
 * caps"), so `K.1.1` is not an address. Case is preserved but compared case-insensitively
 * nowhere — "K" and "k" are different addresses; the fleet keys are upper-case by convention.
 */

export type AddressKind = 'agent' | 'child' | 'operator' | 'room' | 'broadcast';

export interface ParsedAddress {
  raw: string;
  kind: AddressKind;
  /** For children: the parent agent address. */
  parent?: string;
  /** For children: the per-parent sequence number. */
  seq?: number;
}

export const OPERATOR = 'operator';
export const BROADCAST = '@all';

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHILD_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([1-9][0-9]{0,8})$/;
const ROOM_RE = /^#[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Parse an address or return null if it fits no form. */
export function parseAddress(raw: string): ParsedAddress | null {
  if (typeof raw !== 'string') return null;
  if (raw === OPERATOR) return { raw, kind: 'operator' };
  if (raw === BROADCAST) return { raw, kind: 'broadcast' };
  if (ROOM_RE.test(raw)) return { raw, kind: 'room' };
  const child = CHILD_RE.exec(raw);
  if (child) {
    const parent = child[1];
    if (parent === OPERATOR) return null; // the operator does not mint children
    return { raw, kind: 'child', parent, seq: Number(child[2]) };
  }
  if (AGENT_RE.test(raw)) return { raw, kind: 'agent' };
  return null;
}

/** Parse or throw — for writers that must not persist garbage. */
export function requireAddress(raw: string, role: 'from' | 'to'): ParsedAddress {
  const parsed = parseAddress(raw);
  if (!parsed) {
    throw new Error(
      `invalid ${role} address ${JSON.stringify(raw)}: expected a fleet id (K, codex-B), ` +
      `a child (K.1), "operator", a room (#name) or "@all"`,
    );
  }
  return parsed;
}

/** True for addresses that can SEND (rooms and @all only receive). */
export function canSend(parsed: ParsedAddress): boolean {
  return parsed.kind === 'agent' || parsed.kind === 'child' || parsed.kind === 'operator';
}

/** Build a child address; the log's mintChild() is the only intended caller. */
export function childAddress(parent: string, seq: number): string {
  return `${parent}.${seq}`;
}
