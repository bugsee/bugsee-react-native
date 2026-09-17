/**
 * Stand-in for the TurboModule. Every JS test drives the facade through this,
 * so a test failure means the facade is wrong, never that a device misbehaved.
 */

/** What a freshly reset mock resolves, for the calls that return something. */
const DEFAULTS: Record<string, unknown> = {
  launch: true,
  relaunch: true,
  stop: true,
  getStatus: 0,
  getLaunchOptions: {},
};

export const native = {
  setWrapperInfo: jest.fn<void, [Record<string, unknown>]>(),
  launch: jest.fn<Promise<boolean>, [string, Record<string, unknown>]>(),
  relaunch: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  stop: jest.fn<Promise<boolean>, []>(),
  getStatus: jest.fn<Promise<number>, []>(),
  getLaunchOptions: jest.fn<Promise<Record<string, unknown>>, []>(),
  testCrash: jest.fn<void, []>(),

  /**
   * Resets every mock on this object, found rather than listed.
   *
   * A hardcoded list silently stops covering a method the moment the spec
   * grows one: `setWrapperInfo` was added and kept its call count across
   * tests, so assertions on "called once" saw two, three, four. The same
   * species of bug as a hardcoded list of spec methods or CI matrix versions.
   */
  reset(): void {
    for (const [name, value] of Object.entries(this)) {
      if (typeof value === 'function' && 'mockReset' in value) {
        const fn = value as jest.Mock;
        fn.mockReset();
        if (name in DEFAULTS) {
          fn.mockResolvedValue(DEFAULTS[name]);
        }
      }
    }
  },
};

export const nativeMock = { __esModule: true, default: native };
