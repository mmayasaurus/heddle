import type { Ledger } from '../ledger.js';

// ---- HED-148 part B: monoculture warning (advisory, never a refusal) --------------------------
// A direct dispatch that just cleared the override-reason gate is deliberate — but if one agent's
// recent hand-picking is lopsided toward a single provider, that's worth a nudge: a task class exists
// precisely to spread that load, and a human reading a wall of "codex, codex, codex" direct rows has
// no signal an alternative was available. Warn only — never blocks, never writes the ledger.
const MONOCULTURE_WINDOW_MS = 8 * 60 * 60 * 1000;

const MONOCULTURE_FLOOR = 5;

const MONOCULTURE_SHARE_THRESHOLD = 0.6;

export interface MonocultureNote {
  /** The direct-dispatch provider whose share tripped the guard. */
  provider: string;
  /** Total qualifying (non-refused) direct dispatches in the window. */
  directCount: number;
  /** `provider`'s share of `directCount`, as a percentage (0-100). */
  directPct: number;
  /** Direct-route provider counts in the window — the metric that triggers this note. */
  directMix: Record<string, number>;
  /** Class-routed provider counts in the same window — context only, never part of the trigger. */
  classRoutedMix: Record<string, number>;
}

/**
 * Non-blocking signal that one agent's recent DIRECT (hand-picked provider+model) dispatches lean
 * heavily toward one provider. Class-routed dispatches never count toward the trigger — task-class
 * routing IS the diversification lever, and counting it here would penalize using it.
 */
export function monocultureNote(ledger: Ledger, agent: string, opts?: { now?: Date }): MonocultureNote | null {
  const now = opts?.now ?? new Date();
  const sinceIso = new Date(now.getTime() - MONOCULTURE_WINDOW_MS).toISOString();
  const { directMix, classRoutedMix } = ledger.directAndClassMix(agent, sinceIso);
  const directCount = Object.values(directMix).reduce((sum, n) => sum + n, 0);
  if (directCount < MONOCULTURE_FLOOR) return null;
  const [provider, count] = Object.entries(directMix).sort(([, a], [, b]) => b - a)[0];
  const share = count / directCount;
  if (share <= MONOCULTURE_SHARE_THRESHOLD) return null;
  return { provider, directCount, directPct: share * 100, directMix, classRoutedMix };
}

/** Pure formatter — one stderr line, both mixes so the reader sees the whole picture, not just the trip. */
export function formatMonocultureWarning(note: MonocultureNote): string {
  const fmtMix = (mix: Record<string, number>): string => {
    const parts = Object.entries(mix).sort(([, a], [, b]) => b - a).map(([provider, n]) => `${n} ${provider}`);
    return parts.length ? parts.join(', ') : 'none';
  };
  return `monoculture-warning: direct dispatches are ${Math.round(note.directPct)}% ${note.provider} over 8h ` +
    `(direct: ${fmtMix(note.directMix)}; class-routed: ${fmtMix(note.classRoutedMix)}) — ` +
    `task classes spread this load across providers; dispatch by class where one fits`;
}
