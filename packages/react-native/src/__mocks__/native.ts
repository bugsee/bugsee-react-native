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
/** Synchronous returns. A Promise default would make a boolean read back a Promise. */
const SYNC_RETURNS: Record<string, unknown> = {
  noteConsoleEcho: true,
  setAppearanceColor: true,
  getAppearanceColor: '',
  // An unknown surface: no origin of its own.
  secureSurfaceOrigin: [],
};

const DEFAULTS: Record<string, unknown> = {
  launch: true,
  relaunch: true,
  stop: true,
  getStatus: 0,
  getLaunchOptions: {},
  reportRead: EMPTY_REPORT_SNAPSHOT,
  createReport: null,
  getAttribute: {},
  getAllAttributes: {},
  getUserIdentifier: {},
  // logUnhandledException resolves by default (undefined / void).
  logUnhandledException: undefined,
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

interface DataRequestEvent {
  requestId: string;
  type: string;
  originX: number;
  originY: number;
}

interface NetworkFilterRequestEvent {
  requestId: string;
  eventJson: string;
}

const networkFilterRequestListeners = new Set<(event: NetworkFilterRequestEvent) => void>();

/** Counted separately from the Set's size, for the same reason as `reportHandlerRequestSubscribeCalls`. */
let networkFilterRequestSubscribeCalls = 0;

const dataRequestListeners = new Set<(event: DataRequestEvent) => void>();

/** Counted separately from the Set's size, for the same reason as `reportHandlerRequestSubscribeCalls`: the dispatcher always passes the same function reference, so the Set alone cannot tell "subscribed once" from "subscribed four times, deduped". */
let dataRequestSubscribeCalls = 0;

interface LogFilterRequestEvent {
  requestId: string;
  line: string;
}

const logFilterRequestListeners = new Set<(event: LogFilterRequestEvent) => void>();

/** Counted separately from the Set's size, for the same reason as `reportHandlerRequestSubscribeCalls`. */
let logFilterRequestSubscribeCalls = 0;

interface BreadcrumbFilterRequestEvent {
  requestId: string;
  crumbJson: string;
  /** Present only for the manual add that passed this id. SDK crumbs omit it. */
  addId?: string;
}

const breadcrumbFilterRequestListeners = new Set<
  (event: BreadcrumbFilterRequestEvent) => void
>();

/** Counted separately from the Set's size, for the same reason as `reportHandlerRequestSubscribeCalls`. */
let breadcrumbFilterRequestSubscribeCalls = 0;

export const native = {
  setWrapperInfo: jest.fn<void, [Record<string, unknown>]>(),
  setSecureRectangles: jest.fn<void, [number, number[]]>(),
  setSecureRectanglesOnSurface: jest.fn<void, [number, number, number[]]>(),
  secureSurfaceOrigin: jest.fn<number[], [number]>(),
  startBlackout: jest.fn<void, []>(),
  endBlackout: jest.fn<void, []>(),
  isBlackout: jest.fn<Promise<boolean>, []>(),
  captureViewHierarchy: jest.fn<void, []>(),

  /**
   * The codegen EventEmitter for the SDK's data requests -- a SUBSCRIBE
   * function returning an unsubscribe handle, exactly like `onLifecycleEvent`
   * and `onReportHandlerRequest` above. Tests drive it with
   * `emitDataRequest`, standing in for native.
   */
  onDataRequest(listener: (event: DataRequestEvent) => void) {
    dataRequestSubscribeCalls += 1;
    dataRequestListeners.add(listener);
    return {
      remove: () => {
        dataRequestListeners.delete(listener);
      },
    };
  },

  /** Stands in for the native emit. */
  emitDataRequest(event: DataRequestEvent): void {
    for (const listener of [...dataRequestListeners]) listener(event);
  },

  /** How many subscribers are attached. */
  dataRequestListenerCount(): number {
    return dataRequestListeners.size;
  },

  /** How many times `onDataRequest` was actually called, deduping aside -- proves "subscribes once" even across many registered anchors. */
  dataRequestSubscribeCallCount(): number {
    return dataRequestSubscribeCalls;
  },

  replyDataRequest: jest.fn<void, [string, string | null]>(),
  setViewTreeEnabled: jest.fn<void, [boolean]>(),

  /**
   * The codegen EventEmitter for a native network-filter request. Tests
   * drive it with `emitNetworkFilterRequest`. `eventJson` is the event the
   * SDK handed the filter. The reply is that event's replacement as JSON,
   * or `null` to drop it.
   */
  onNetworkFilterRequest(listener: (event: NetworkFilterRequestEvent) => void) {
    networkFilterRequestSubscribeCalls += 1;
    networkFilterRequestListeners.add(listener);
    return {
      remove: () => {
        networkFilterRequestListeners.delete(listener);
      },
    };
  },

  emitNetworkFilterRequest(event: NetworkFilterRequestEvent): void {
    for (const listener of [...networkFilterRequestListeners]) listener(event);
  },

  networkFilterRequestSubscribeCallCount(): number {
    return networkFilterRequestSubscribeCalls;
  },

  setNetworkFilterEnabled: jest.fn<void, [boolean]>(),
  replyNetworkFilter: jest.fn<void, [string, string | null]>(),

  /**
   * The codegen EventEmitter for a native log-filter request. Tests drive it
   * with `emitLogFilterRequest`. `line` is what native would send back: a
   * replacement string, or `null` to drop.
   */
  onLogFilterRequest(listener: (event: LogFilterRequestEvent) => void) {
    logFilterRequestSubscribeCalls += 1;
    logFilterRequestListeners.add(listener);
    return {
      remove: () => {
        logFilterRequestListeners.delete(listener);
      },
    };
  },

  emitLogFilterRequest(event: LogFilterRequestEvent): void {
    for (const listener of [...logFilterRequestListeners]) listener(event);
  },

  logFilterRequestSubscribeCallCount(): number {
    return logFilterRequestSubscribeCalls;
  },

  setLogFilterEnabled: jest.fn<void, [boolean]>(),
  replyLogFilter: jest.fn<void, [string, string | null]>(),
  noteConsoleEcho: jest.fn<boolean, [string]>(() => true),

  /**
   * `level` is the name (`debug`, `info`, `warning`, `error`, `fatal`).
   * `dataJson` is JSON text, or null when the caller supplied no data.
   * The last argument is the manual add's id, or null when no filter is
   * installed. Returns true when a filter request for that id will be
   * emitted. Tests that simulate capture being off return false.
   */
  addBreadcrumb: jest.fn<
    boolean,
    [string, string, string, string, string | null, string | null]
  >(() => true),

  /**
   * The codegen EventEmitter for a native breadcrumb-filter request. Tests
   * drive it with `emitBreadcrumbFilterRequest`. `crumbJson` is the snapshot
   * native would send; the reply is a keep as JSON text, or `null` to drop.
   */
  onBreadcrumbFilterRequest(listener: (event: BreadcrumbFilterRequestEvent) => void) {
    breadcrumbFilterRequestSubscribeCalls += 1;
    breadcrumbFilterRequestListeners.add(listener);
    return {
      remove: () => {
        breadcrumbFilterRequestListeners.delete(listener);
      },
    };
  },

  emitBreadcrumbFilterRequest(event: BreadcrumbFilterRequestEvent): void {
    for (const listener of [...breadcrumbFilterRequestListeners]) listener(event);
  },

  breadcrumbFilterRequestSubscribeCallCount(): number {
    return breadcrumbFilterRequestSubscribeCalls;
  },

  setBreadcrumbFilterEnabled: jest.fn<void, [boolean]>(),
  replyBreadcrumbFilter: jest.fn<void, [string, string | null]>(),

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
  upload: jest.fn<void, [string, string, number, string[] | null]>(),
  showReportDialog:
    jest.fn<void, [string | null, string | null, number, string[] | null]>(),
  wrapperLog: jest.fn<void, [string, number]>(),
  /** `paramsJson` is JSON text (`encodeBridgeObject`), or null for no params. */
  event: jest.fn<void, [string, string | null]>(),
  traceNumber: jest.fn<void, [string, number]>(),
  traceString: jest.fn<void, [string, string]>(),
  traceBoolean: jest.fn<void, [string, boolean]>(),

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

  setAttributeString: jest.fn<Promise<void>, [string, string]>(),
  setAttributeNumber: jest.fn<Promise<void>, [string, number]>(),
  setAttributeBoolean: jest.fn<Promise<void>, [string, boolean]>(),
  getAttribute: jest.fn<Promise<unknown>, [string]>(),
  getAllAttributes: jest.fn<Promise<unknown>, []>(),
  clearAttribute: jest.fn<Promise<void>, [string]>(),
  clearAllAttributes: jest.fn<Promise<void>, []>(),
  setUserIdentifier: jest.fn<void, [string]>(),
  getUserIdentifier: jest.fn<Promise<unknown>, []>(),
  clearUserIdentifier: jest.fn<void, []>(),

  setReportHandlerPhases: jest.fn<void, [boolean, boolean]>(),
  completeReportHandler: jest.fn<void, [string]>(),
  reportRead: jest.fn<Promise<unknown>, [string]>(),
  /** `patchJson` is the validated patch as JSON text (`encodeBridgeObject`). */
  reportUpdate: jest.fn<Promise<void>, [string, string]>(),
  reportAddFileAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null, boolean]>(),
  reportAddDataAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null]>(),

  /** Resolves `null` by default: native made none. */
  createReport: jest.fn<Promise<string | null>, []>(),
  createdReportRead: jest.fn<Promise<unknown>, [string]>(),
  /** `patchJson` is the validated patch as JSON text (`encodeBridgeObject`). */
  createdReportUpdate: jest.fn<Promise<void>, [string, string]>(),
  createdReportAddDataAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null]>(),
  /** No `move` argument: a created-report file is copied. */
  createdReportAddFileAttachment:
    jest.fn<Promise<void>, [string, string, string, string | null]>(),
  createdReportUpload: jest.fn<Promise<boolean>, [string]>(),

  /**
   * A network event the app recorded itself, as JSON text. Native builds it
   * with the SDK exchange factory and submits it with filtering required.
   * JS does not run the network filter.
   */
  addNetworkEvent: jest.fn<void, [string]>(),

  /** `payloadJson` / `optionsJson` are JSON text (`encodeBridgeObject` / `encodeExceptionOptions`). */
  logException: jest.fn<void, [string, string | null]>(),
  /** Resolves by default; tests that hang native replace the implementation. */
  logUnhandledException: jest.fn<Promise<void>, [string]>(),

  notify: jest.fn<void, [string, string | null, number, string | null, boolean]>(),
  startTransaction: jest.fn<Record<string, unknown>, [string, string, string | null]>(),
  startSpan: jest.fn<Record<string, unknown>, [string, string | null]>(),
  getActiveSpan: jest.fn<Record<string, unknown>, []>(),
  spanSetName: jest.fn<boolean, [string, string]>(),
  spanSetDescription: jest.fn<boolean, [string, string | null]>(),
  spanSetAttribute: jest.fn<boolean, [string, string, string]>(),
  spanSetStatus: jest.fn<boolean, [string, number]>(),
  spanStartChild: jest.fn<Record<string, unknown>, [string, string, string | null]>(),
  spanFinish: jest.fn<string[], [string, number, boolean]>(),

  setAppearanceColor: jest.fn<boolean, [string, number, number, number, number]>(),
  getAppearanceColor: jest.fn<string, [string]>(),
  deleteCollectedDataOnDevice: jest.fn<Promise<boolean>, [boolean]>(),

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
    dataRequestListeners.clear();
    dataRequestSubscribeCalls = 0;
    networkFilterRequestListeners.clear();
    networkFilterRequestSubscribeCalls = 0;
    logFilterRequestListeners.clear();
    logFilterRequestSubscribeCalls = 0;
    breadcrumbFilterRequestListeners.clear();
    breadcrumbFilterRequestSubscribeCalls = 0;
    for (const [name, value] of Object.entries(this)) {
      if (typeof value === 'function' && 'mockReset' in value) {
        const fn = value as jest.Mock;
        fn.mockReset();
        if (name in DEFAULTS) {
          fn.mockResolvedValue(DEFAULTS[name]);
        } else if (name in SYNC_RETURNS) {
          fn.mockReturnValue(SYNC_RETURNS[name]);
        }
      }
    }
  },
};

export const nativeMock = { __esModule: true, default: native };

/** Key-sorted JSON, so two values compare by content rather than key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    // Read, never assigned: a "__proto__" member stays an ordinary key here.
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * An asymmetric matcher for an object payload that crosses as JSON text:
 * matches only a STRING that parses to a value deep-equal to `expected` (key
 * order aside). An object where the text should be fails it, so
 * `toHaveBeenCalledWith('h1', jsonOf({ summary: null }))` pins both the
 * transport and the content.
 */
export function jsonOf(expected: unknown): unknown {
  const want = canonicalJson(expected);
  return {
    $$typeof: Symbol.for('jest.asymmetricMatcher'),
    asymmetricMatch(actual: unknown): boolean {
      if (typeof actual !== 'string') return false;
      try {
        return canonicalJson(JSON.parse(actual)) === want;
      } catch {
        return false;
      }
    },
    toString: () => 'jsonOf',
    toAsymmetricMatcher: () => `jsonOf(${want})`,
    getExpectedType: () => 'string',
  };
}
