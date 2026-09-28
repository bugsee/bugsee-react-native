/**
 * Stand-in for the TurboModule. Every JS test drives the facade through this,
 * so a test failure means the facade is wrong, never that a device misbehaved.
 */

/** The empty snapshot shape `reportRead` resolves to by default. */
const EMPTY_REPORT_SNAPSHOT = {
  summary: null,
  description: null,
  severity: 0,
  labels: [],
  attributes: {},
  screenshotDisplayIds: [],
  attachmentNames: [],
};

/** What a freshly reset mock resolves, for the calls that return something. */
const DEFAULTS: Record<string, unknown> = {
  launch: true,
  relaunch: true,
  stop: true,
  getStatus: 0,
  getLaunchOptions: {},
  reportRead: EMPTY_REPORT_SNAPSHOT,
};

const lifecycleListeners = new Set<(event: { name: string; reportId?: string }) => void>();

interface ReportHandlerRequestEvent {
  handleId: string;
  phase: string;
  reportId: string;
  type: string;
  deadlineMs: number;
}

const reportHandlerRequestListeners = new Set<
  (event: ReportHandlerRequestEvent) => void
>();

/**
 * Counted separately from the Set's size: the dispatcher always passes the
 * SAME module-level function reference, so a `Set` silently dedupes a second
 * subscribe call and the size alone cannot tell "subscribed once" from
 * "subscribed four times, deduped". This counts every call.
 */
let reportHandlerRequestSubscribeCalls = 0;

export const native = {
  setWrapperInfo: jest.fn<void, [Record<string, unknown>]>(),
  setSecureRectangles: jest.fn<void, [number, number[]]>(),

  /**
   * The codegen EventEmitter, which is a SUBSCRIBE function returning an
   * unsubscribe handle -- not a jest.fn to assert calls on. Tests drive it by
   * calling `emitLifecycle`, which is what the native side would do.
   */
  onLifecycleEvent(listener: (event: { name: string; reportId?: string }) => void) {
    lifecycleListeners.add(listener);
    return { remove: () => { lifecycleListeners.delete(listener); } };
  },

  /** Stands in for the native emit. */
  emitLifecycle(event: { name: string; reportId?: string }): void {
    for (const listener of [...lifecycleListeners]) listener(event);
  },

  /** How many subscribers are attached -- proves `remove` actually detaches. */
  lifecycleListenerCount(): number {
    return lifecycleListeners.size;
  },
  launch: jest.fn<Promise<boolean>, [string, Record<string, unknown>]>(),
  relaunch: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  stop: jest.fn<Promise<boolean>, []>(),
  getStatus: jest.fn<Promise<number>, []>(),
  getLaunchOptions: jest.fn<Promise<Record<string, unknown>>, []>(),
  testCrash: jest.fn<void, []>(),
  upload: jest.fn<void, [string, string]>(),
  wrapperLog: jest.fn<void, [string, number]>(),

  /**
   * The codegen EventEmitter for report handoffs -- a SUBSCRIBE function
   * returning an unsubscribe handle, exactly like `onLifecycleEvent` above.
   * Tests drive it with `emitReportHandlerRequest`, standing in for native.
   */
  onReportHandlerRequest(listener: (event: ReportHandlerRequestEvent) => void) {
    reportHandlerRequestSubscribeCalls += 1;
    reportHandlerRequestListeners.add(listener);
    return {
      remove: () => {
        reportHandlerRequestListeners.delete(listener);
      },
    };
  },

  /** Stands in for the native emit. */
  emitReportHandlerRequest(event: ReportHandlerRequestEvent): void {
    for (const listener of [...reportHandlerRequestListeners]) listener(event);
  },

  /** How many subscribers are attached -- proves the dispatcher subscribes at most once. */
  reportHandlerRequestListenerCount(): number {
    return reportHandlerRequestListeners.size;
  },

  /** How many times `onReportHandlerRequest` was actually called, deduping aside. */
  reportHandlerRequestSubscribeCallCount(): number {
    return reportHandlerRequestSubscribeCalls;
  },

  setReportHandlerPhases: jest.fn<void, [boolean, boolean]>(),
  completeReportHandler: jest.fn<void, [string]>(),
  reportRead: jest.fn<Promise<unknown>, [string]>(),
  reportUpdate: jest.fn<Promise<void>, [string, unknown]>(),
  reportAddFileAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null, boolean]>(),
  reportAddDataAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null]>(),

  /**
   * Resets every mock on this object, found rather than listed.
   *
   * A hardcoded list silently stops covering a method the moment the spec
   * grows one: `setWrapperInfo` was added and kept its call count across
   * tests, so assertions on "called once" saw two, three, four. The same
   * species of bug as a hardcoded list of spec methods or CI matrix versions.
   */
  reset(): void {
    lifecycleListeners.clear();
    reportHandlerRequestListeners.clear();
    reportHandlerRequestSubscribeCalls = 0;
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
