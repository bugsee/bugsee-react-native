/**
 * Stand-in for the TurboModule. Every JS test drives the facade through this,
 * so a test failure means the facade is wrong, never that a device misbehaved.
 */
export const native = {
  launch: jest.fn<Promise<boolean>, [string, Record<string, unknown>]>(),
  relaunch: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  stop: jest.fn<Promise<boolean>, []>(),
  getStatus: jest.fn<Promise<number>, []>(),
  testCrash: jest.fn<void, []>(),
  reset() {
    for (const fn of [this.launch, this.relaunch, this.stop, this.getStatus, this.testCrash]) {
      fn.mockReset();
    }
    this.launch.mockResolvedValue(true);
    this.relaunch.mockResolvedValue(true);
    this.stop.mockResolvedValue(true);
    this.getStatus.mockResolvedValue(0);
  },
};

export const nativeMock = { __esModule: true, default: native };
