import { existsSync } from 'node:fs';

import { newPulledRoot, removePulledBundles } from '../../examples/bare/e2e/bundles';

/**
 * Pulled bundles hold what the SDK wrote, and on iOS beta3 that includes
 * credentials (`log.internal.json`). Every temp root a suite pulled into is
 * removed when it ends, unless E2E_KEEP_BUNDLES=1 asks to keep them.
 */
describe('pulled bundle roots', () => {
  const saved = process.env.E2E_KEEP_BUNDLES;

  afterEach(() => {
    // Whatever a case kept, the test itself leaves nothing behind.
    delete process.env.E2E_KEEP_BUNDLES;
    removePulledBundles();
    if (saved !== undefined) process.env.E2E_KEEP_BUNDLES = saved;
  });

  it('removes every root created, and reports them', () => {
    delete process.env.E2E_KEEP_BUNDLES;
    const a = newPulledRoot();
    const b = newPulledRoot();
    expect(existsSync(a) && existsSync(b)).toBe(true);

    expect(removePulledBundles()).toEqual({ removed: [a, b], kept: [] });

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(removePulledBundles()).toEqual({ removed: [], kept: [] });
  });

  it('keeps them with E2E_KEEP_BUNDLES=1', () => {
    process.env.E2E_KEEP_BUNDLES = '1';
    const a = newPulledRoot();

    expect(removePulledBundles()).toEqual({ removed: [], kept: [a] });

    expect(existsSync(a)).toBe(true);
  });
});
