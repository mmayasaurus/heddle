/**
 * heddle comms broker — public surface.
 *
 *   log.ts       durable append-only message log + participant registry (HED-4)
 *   address.ts   address grammar: agents · children · operator · rooms · @all
 *   types.ts     shared types
 *
 * Later layers (envelopes/HED-5, delivery discipline/HED-6, SendMessage bridge/HED-7, MCP
 * tools) sit on top of the log; nothing bypasses it.
 */
export * from './types.js';
export * from './address.js';
export * from './log.js';
