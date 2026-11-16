/**
 * Where each public native SDK method lives in `@bugsee/react-native`, or why it
 * does not.
 *
 * `scripts/sdk-api.json` holds the method names of the pinned SDKs; the parity
 * test fails when a name there has no entry here (a method a new SDK release
 * added, which someone must either bridge or exempt with a reason) or an entry
 * here names nothing in the SDK (stale).
 *
 * - `rn`: a member of the default `Bugsee` export that covers it.
 * - `export`: a named export of the package that covers it.
 * - `skip`: deliberately not exposed, and why.
 */
export type Mapping = { rn: string } | { export: string } | { skip: string };

const rn = (member: string): Mapping => ({ rn: member });
const component = (name: string): Mapping => ({ export: name });
const skip = (reason: string): Mapping => ({ skip: reason });

const SECURE_VIEWS = component('BugseeSecure');
const WEBVIEW = skip('needs a native WKWebView/WebView instance, which JavaScript never holds');
const NOT_READ_BACK = skip('the wrapper owns the rectangles it publishes; the SDK list is not read back');
const EXT = skip('native extension lookup and registration; extension SPIs are not callable from JavaScript');
const SANITIZER = skip('used inside the wrapper\'s own network-filter bridge, not callable from JavaScript');
const EXCHANGE = skip('internal: builds the events addNetworkEvent and addBreadcrumb take');
const DEBUG_OVERLAY = skip('an iOS SDK debug overlay for checking video capture; deliberately not exposed');
const STATUS = skip('derivable: `await getStatus()` against `Status.Launched`');

export const ANDROID: Readonly<Record<string, Mapping>> = {
  addBreadcrumb: rn('addBreadcrumb'),
  addNetworkEvent: rn('addNetworkEvent'),
  addSecureActivity: rn('addSecureActivity'),
  addSecureRectangle: rn('setSecureRectangles'),
  addSecureView: SECURE_VIEWS,
  addSecureViews: skip('deprecated in the SDK (layout-id based)'),
  addSecureWebView: WEBVIEW,
  captureViewHierarchy: rn('captureViewHierarchy'),
  clearAllAttributes: rn('clearAllAttributes'),
  clearAttribute: rn('clearAttribute'),
  clearUserIdentifier: rn('clearUserIdentifier'),
  createReport: rn('createReport'),
  deleteCollectedDataOnDevice: rn('deleteCollectedDataOnDevice'),
  endBlackout: rn('endBlackout'),
  event: rn('event'),
  ext: EXT,
  getActiveSpan: rn('getActiveSpan'),
  getAllAttributes: rn('getAllAttributes'),
  getAllSecureRectangles: NOT_READ_BACK,
  getAppearance: rn('appearance'),
  getAttribute: rn('getAttribute'),
  getDefaultNetworkSanitizer: SANITIZER,
  getExchangeFactory: EXCHANGE,
  getHostLaunchOptions: rn('getHostLaunchOptions'),
  getLaunchOptions: rn('getLaunchOptions'),
  getLaunched: STATUS,
  getStatus: rn('getStatus'),
  getUserIdentifier: rn('getUserIdentifier'),
  getVideoFrameConsumer: skip('SPI for wrappers that feed their own video frames; this wrapper records natively'),
  isBlackout: rn('isBlackout'),
  isSecureActivity: rn('isSecureActivity'),
  launch: rn('launch'),
  log: rn('log'),
  logException: rn('logException'),
  logUnhandledException: rn('logUnhandledException'),
  notify: rn('notify'),
  onUncaughtException: skip('the wrapper\'s own exception handlers call logUnhandledException'),
  registerExt: EXT,
  relaunch: rn('relaunch'),
  removeAllSecureRectangles: rn('setSecureRectangles'),
  removeSecureActivity: rn('removeSecureActivity'),
  removeSecureRectangle: rn('setSecureRectangles'),
  removeSecureView: SECURE_VIEWS,
  resetVideoCapturePermission: rn('resetVideoCapturePermission'),
  setAttribute: rn('setAttribute'),
  setBreadcrumbFilter: rn('setBreadcrumbFilter'),
  setLifecycleEventsListener: rn('onLifecycleEvent'),
  setLogEventFilter: rn('setLogFilter'),
  setLogFilter: skip('deprecated in the SDK; replaced by setLogEventFilter'),
  setNetworkEventFilter: rn('setNetworkFilter'),
  setReportHandler: rn('setReportHandler'),
  setUserIdentifier: rn('setUserIdentifier'),
  setWrapper: skip('the wrapper registers itself (setWrapperInfo, and at process start on Android)'),
  showReportDialog: rn('showReportDialog'),
  startBlackout: rn('startBlackout'),
  startSpan: rn('startSpan'),
  startTransaction: rn('startTransaction'),
  stop: rn('stop'),
  testCrash: rn('testNativeCrash'),
  trace: rn('trace'),
  upload: rn('upload'),
};

export const IOS: Readonly<Record<string, Mapping>> = {
  addBreadcrumb: rn('addBreadcrumb'),
  addNetworkEvent: rn('addNetworkEvent'),
  addSecureRectangle: rn('setSecureRectangles'),
  addSecureView: SECURE_VIEWS,
  addSecureWebView: WEBVIEW,
  captureViewHierarchy: rn('captureViewHierarchy'),
  clearAllAttributes: rn('clearAllAttributes'),
  clearAttribute: rn('clearAttribute'),
  clearUserIdentifier: rn('clearUserIdentifier'),
  createReportWithCompletion: rn('createReport'),
  defaultNetworkSanitizer: SANITIZER,
  delegate: skip('BugseeDelegate belongs to the wrapper: its callbacks reach JavaScript as onLifecycleEvent, setReportHandler and the filters'),
  deleteCollectedDataOnDevice: rn('deleteCollectedDataOnDevice'),
  endBlackout: rn('endBlackout'),
  event: rn('event'),
  ext: EXT,
  getActiveSpan: rn('getActiveSpan'),
  getAllAttributes: rn('getAllAttributes'),
  getAllSecureRectangles: NOT_READ_BACK,
  getAppearance: rn('appearance'),
  getAttribute: rn('getAttribute'),
  getExchangeFactory: EXCHANGE,
  getHostLaunchOptions: rn('getHostLaunchOptions'),
  getLaunchOptions: rn('getLaunchOptions'),
  getUserIdentifier: rn('getUserIdentifier'),
  hideVideoCapturePreview: DEBUG_OVERLAY,
  isBlackout: rn('isBlackout'),
  launchWithToken: rn('launch'),
  launched: STATUS,
  log: rn('log'),
  logError: rn('logException'),
  logException: rn('logException'),
  logUnhandledException: rn('logUnhandledException'),
  notifyWithTitle: rn('notify'),
  relaunch: rn('relaunch'),
  relaunchWithDictionaryOptions: rn('relaunch'),
  relaunchWithOptions: rn('relaunch'),
  removeAllSecureRectangles: rn('setSecureRectangles'),
  removeSecureRectangle: rn('setSecureRectangles'),
  removeSecureView: SECURE_VIEWS,
  setAttribute: rn('setAttribute'),
  setBreadcrumbFilter: rn('setBreadcrumbFilter'),
  setLogEventFilter: rn('setLogFilter'),
  setNetworkEventFilter: rn('setNetworkFilter'),
  setReportHandler: rn('setReportHandler'),
  setUserIdentifier: rn('setUserIdentifier'),
  sharedInstance: skip('singleton accessor; the wrapper calls the class methods directly'),
  showReportDialog: rn('showReportDialog'),
  showReportDialogWithSummary: rn('showReportDialog'),
  showVideoCapturePreview: DEBUG_OVERLAY,
  startBlackout: rn('startBlackout'),
  startSpanWithOperation: rn('startSpan'),
  startTransactionWithName: rn('startTransaction'),
  status: rn('getStatus'),
  stop: rn('stop'),
  testCrash: rn('testNativeCrash'),
  trace: rn('trace'),
  uploadReport: rn('createReport'),
  uploadWithSummary: rn('upload'),
};
