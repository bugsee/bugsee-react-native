import { existsSync, rmSync } from 'node:fs';

import { newPulledRoot, removePulledBundles } from '../../examples/bare/e2e/bundles';

/**
 * Pulled bundles hold what the SDK wrote, and on iOS beta3 that includes
 * credentials (`log.internal.json`). Every temp root a suite pulled into is
 * removed when it ends, unless E2E_KEEP_BUNDLES=1 asks to keep them.
 */
describe('pulled bundle roots', () => {
  const saved = process.env.E2E_KEEP_BUNDLES;
  let created: string[] = [];

  /**
   * `newPulledRoot()`, tracked so the bound below checks only the roots
   * *this test* created -- not every `bugsee-bundles-*` directory in the OS
   * temp dir, which a concurrent process (another Jest worker, say) could
   * also be writing into.
   */
  function trackedPulledRoot(): string {
    const root = newPulledRoot();
    created.push(root);
    return root;
  }

  afterEach(() => {
    // removePulledBundles() empties its tracked list whether it deletes a
    // root or keeps it -- so a root a case asked to keep is untracked
    // afterwards, and this hook can no longer remove it. It can only ever
    // clean up what is still tracked; a case that keeps a root is
    // responsible for deleting that root itself.
    delete process.env.E2E_KEEP_BUNDLES;
    removePulledBundles();
    if (saved !== undefined) process.env.E2E_KEEP_BUNDLES = saved;

    // No root this test created survives it, whether the case above cleaned
    // it up via removePulledBundles() or by hand.
    expect(created.filter(existsSync)).toEqual([]);
    created = [];
  });

  it('removes every root created, and reports them', () => {
    delete process.env.E2E_KEEP_BUNDLES;
    const a = trackedPulledRoot();
    const b = trackedPulledRoot();
    expect(existsSync(a) && existsSync(b)).toBe(true);

    expect(removePulledBundles()).toEqual({ removed: [a, b], kept: [] });

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(removePulledBundles()).toEqual({ removed: [], kept: [] });
  });

  it('keeps them with E2E_KEEP_BUNDLES=1', () => {
    process.env.E2E_KEEP_BUNDLES = '1';
    const a = trackedPulledRoot();

    try {
      expect(removePulledBundles()).toEqual({ removed: [], kept: [a] });
      expect(existsSync(a)).toBe(true);
    } finally {
      // removePulledBundles() has already untracked `a` (it splices its list
      // regardless of whether it deletes or keeps), so nothing else will
      // ever remove it -- this test asked to keep it, so this test deletes
      // it, even if an assertion above this point failed.
      rmSync(a, { recursive: true, force: true });
    }
  });
});
