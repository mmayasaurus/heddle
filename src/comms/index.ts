/**
 * heddle comms broker — public surface.
 *
 *   log.ts       durable append-only message log + participant registry (HED-4)
 *   address.ts   address grammar: agents · children · operator · rooms · @all
 *   envelope.ts  trust tiers: operator · orchestrator-directive · agent-message; verifier + renderer (HED-5)
 *   broker.ts    delivery discipline: prefix addressing · size cap · per-pair rate limit · hold-at-gate · per-target serialization (HED-6)
 *   types.ts     shared types
 *
 * Later layers (SendMessage bridge/HED-7, MCP
 * tools) sit on top of the log; nothing bypasses it.
 */
export * from './types.js';
export * from './address.js';
export * from './log.js';
export * from './envelope.js';
export * from './broker.js';
export * from './bridge.js';
export * from './bootstrap.js';
