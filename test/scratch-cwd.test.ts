import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

// HED-79/HED-158: a `scratch_cwd: true` class (documentation) must run its worker in a fresh scratch
// dir, NEVER the caller's live worktree — even when a cwd is explicitly passed. That removes the live
// worktree the agy destructive-cwd incidents (2-for-2) required, while keeping gemini for docs.
describe('scratch-cwd classes (HED-79/HED-158)', () => {
  const { tempLedger, tempDir } = useTempResources('heddle-scratch-cwd-test-');

  it('runs a scratch_cwd class in a fresh scratch dir (overriding even an explicit cwd), and records both', async () => {
    const callerWorktree = tempDir();
    const fake = fakeAdapter();
    const ledger = tempLedger();
    await dispatch(
      { taskClass: 'documentation', prompt: 'x', cwd: callerWorktree, identity: IDENTITIES.unbound },
      ledger, () => fake.adapter,
    );
    const usedCwd = fake.calls[0].opts.cwd as string;
    expect(usedCwd).not.toBe(callerWorktree);       // NOT the caller's live worktree — the whole point
    expect(usedCwd).toContain('heddle-scratch-');    // a fresh mkdtemp
    const row = ledger.recent(1)[0];
    expect(String(row.cwd)).toContain('heddle-scratch-');       // ledger records the ACTUAL cwd that ran
    expect(String(row.route_reason)).toContain('scratch-cwd');  // and why
    expect(String(row.route_reason)).toContain(callerWorktree); // the requested cwd is preserved for the trail
  });

  it('does NOT override cwd for a non-scratch class', async () => {
    const callerWorktree = tempDir();
    const fake = fakeAdapter();
    await dispatch(
      { taskClass: 'bulk-mechanical', prompt: 'x', cwd: callerWorktree, identity: IDENTITIES.unbound },
      tempLedger(), () => fake.adapter,
    );
    expect(fake.calls[0].opts.cwd).toBe(callerWorktree);
  });
});
