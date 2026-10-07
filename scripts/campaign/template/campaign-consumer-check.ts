/**
 * API-48 / API-49: the public surface, type-checked by a consumer against the
 * installed tarball (`tsc --noEmit` in the generated app). Never executed.
 *
 * Every named export a consumer may import must resolve with the type it is
 * documented to have; every 6.x API removed in 7.x must be a compile error
 * (each `@ts-expect-error` fails the check if the line compiles).
 */
import Bugsee, {
  AndroidLaunchOptions,
  AttributeErrorCode,
  BugseeAttributeError,
  BugseeLaunchOptions,
  BugseeReportError,
  BugseeSecure,
  BugseeSpanError,
  ErrorBoundary,
  FrameRate,
  IOSLaunchOptions,
  IssueSeverity,
  LogLevel,
  PACKAGE_VERSION,
  ReportErrorCode,
  SpanErrorCode,
  SpanStatus,
  type Status,
  VideoMode,
  VideoQuality,
  WRAPPER_TYPE,
  createDefaultLaunchOptions,
  endpointFor,
  type AddedNetworkEvent,
  type AttributeValue,
  type BreadcrumbSnapshot,
  type BreadcrumbFilter,
  type BugseeCreatedReport,
  type BugseeReport,
  type BugseeReportHandler,
  type BugseeSecureProps,
  type BugseeSpan,
  type BugseeTransaction,
  type ErrorBoundaryProps,
  type EventParams,
  type ExceptionOptions,
  type LaunchOptions,
  type LifecycleEvent,
  type LogFilter,
  type NetworkFilter,
  type SecureRectangle,
  type TraceValue,
} from '@bugsee/react-native';

export async function consumer(): Promise<void> {
  const options: BugseeLaunchOptions = createDefaultLaunchOptions();
  options.captureLogs = true;
  options.duration = 60;
  const payload: LaunchOptions = BugseeLaunchOptions.serialize(options);
  const launched: boolean = await Bugsee.launch('token', payload);
  const status: Status = await Bugsee.getStatus();
  const sub = Bugsee.onStatusChange((next: Status) => void next);
  sub.remove();
  const life = Bugsee.onLifecycleEvent((event: LifecycleEvent) => void event);
  life.remove();

  const rects: SecureRectangle[] = [{ x: 0, y: 0, width: 1, height: 1 }];
  await Bugsee.setSecureRectangles(rects);
  const exceptionOptions: ExceptionOptions = { domain: 'consumer' };
  await Bugsee.logException(new Error('x'), exceptionOptions);
  const params: EventParams = { a: 1 };
  await Bugsee.event('e', params);
  const trace: TraceValue = 1;
  await Bugsee.trace('t', trace);
  const value: AttributeValue = 'v';
  await Bugsee.setAttribute('k', value);
  await Bugsee.log('line', LogLevel.Info);

  const handler: BugseeReportHandler = {
    onBeforeReportCreated: async (report: BugseeReport) => void report,
  };
  Bugsee.setReportHandler(handler);
  Bugsee.setReportHandler(null);
  const logFilter: LogFilter = (line) => line;
  Bugsee.setLogFilter(logFilter);
  const networkFilter: NetworkFilter = (event) => event;
  Bugsee.setNetworkFilter(networkFilter);
  const crumbFilter: BreadcrumbFilter = (crumb: BreadcrumbSnapshot) => crumb;
  Bugsee.setBreadcrumbFilter(crumbFilter);
  const added: AddedNetworkEvent | undefined = undefined;
  void added;

  const txn: BugseeTransaction = await Bugsee.startTransaction('n', 'op');
  const span: BugseeSpan = await txn.startChildSpan('child');
  await span.finish(SpanStatus.OK);
  const created: BugseeCreatedReport | null = await Bugsee.createReport();
  void created;

  void [launched, status, PACKAGE_VERSION, WRAPPER_TYPE, endpointFor];
  void [AndroidLaunchOptions, IOSLaunchOptions, FrameRate, IssueSeverity, VideoMode, VideoQuality];
  void [AttributeErrorCode, BugseeAttributeError, BugseeReportError, ReportErrorCode];
  void [BugseeSpanError, SpanErrorCode, BugseeSecure, ErrorBoundary];
  const secureProps: Partial<BugseeSecureProps> = {};
  const boundaryProps: Partial<ErrorBoundaryProps> = {};
  void [secureProps, boundaryProps];

  // Removed in 7.x: each line must NOT compile.
  // @ts-expect-error removed in 7.x
  Bugsee.pause();
  // @ts-expect-error removed in 7.x
  Bugsee.resume();
  // @ts-expect-error removed in 7.x
  Bugsee.setEmail('a@b.c');
  // @ts-expect-error removed in 7.x
  Bugsee.getDeviceId();
  // @ts-expect-error removed in 7.x
  Bugsee.setKeyboardVisibility(true);
  // @ts-expect-error upload(summary, description, severity, labels, includeVideo) is gone
  Bugsee.upload('s', 'd', IssueSeverity.High, [], true);
}
