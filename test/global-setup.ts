import { ensureBuilt } from './helpers/build.js';

export default async function globalSetup(): Promise<void> {
  // Vitest gives each worker its own module registry, so a module-level build promise is a
  // per-worker lock — not a lock at all. Build once here before any worker can read dist/.
  await ensureBuilt();
}
