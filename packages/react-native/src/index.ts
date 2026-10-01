import type { ComponentType } from 'react';
import NativeBugsee from './NativeBugsee';
import { PACKAGE_VERSION } from './version';
import { wrap } from './viewtree/anchor';
import { collectWrapperFacts } from './wrapper/collect';
import { wrapperIdentity } from './wrapper/identity';
import { setOwnerRectangles } from './secure/registry';
import type { SecureRectangle } from './secure/rectangles';
import { Status } from './status';
import { statusForEvent } from './wrapper/events';
import type { LifecycleEvent } from './wrapper/events';
import { setReportHandler as installReportHandler } from './report/dispatcher';
import type { BugseeReportHandler } from './report/types';
import { forwardLog } from './wrapper/channel';
import { type IssueSeverity, LogLevel } from './options/enums';
import { labelsArgument, severityArgument } from './report/fields';
import {
  assertEventOrTraceName,
  assertTraceValue,
  copyEventParams,
} from './data/validate';
import type { EventParams, TraceValue } from './data/validate';
import { encodeBridgeObject } from './bridge/json';
import { AttributeErrorCode, BugseeAttributeError } from './attributes/errors';
import {
  assertIdentifierString,
  normalizeAttributeReadValue,
  normalizeAttributesMap,
  normalizeIdentifier,
  validateAttributeName,
  validateAttributeValue,
} from './attributes/validate';
import type { AttributeReadValue, AttributeValue } from './attributes/validate';
import { encodeExceptionOptions } from './exceptions/options';
import type { ExceptionOptions } from './exceptions/options';
import {
  installExceptionHandlers,
  setExceptionCaptureEnabled,
} from './exceptions/handlers';
import {
  markReported,
  reportHandled,
  reportUnhandled,
} from './exceptions/report';

const DETECT_CRASH_OPTION = 'com.bugsee.option.detect.crash';

function applyExceptionCaptureFromOptions(options: LaunchOptions): void {
  setExceptionCaptureEnabled(options[DETECT_CRASH_OPTION] !== false);
}

export { Status } from './status';

const KNOWN_STATUSES: ReadonlySet<number> = new Set(Object.values(Status));

const KNOWN_ATTRIBUTE_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(AttributeErrorCode),
);

/**
 * Translates a native rejection into a `BugseeAttributeError` carrying the
 * same `.code`, so a caller can match on `.code` no matter which side raised
 * it. Anything else -- including a `BugseeAttributeError` already (JS
 * validation raises those directly) -- passes through unchanged.
 */
function toAttributeError(error: unknown): unknown {
  if (error instanceof BugseeAttributeError) {
    return error;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && KNOWN_ATTRIBUTE_ERROR_CODES.has(code)) {
    const message = (error as { message?: unknown }).message;
    return new BugseeAttributeError(
      code as AttributeErrorCode,
      typeof message === 'string' ? message : code,
    );
  }
  return error;
}

export type LaunchOptions = Record<string, unknown>;

class Bugsee {
  /**
   * Starts the SDK. Resolves to whether the native side actually launched —
   * it can decline (already running, token rejected) without that being an
   * error the caller should throw on.
   *
   * Installs the global JS exception handlers (ErrorUtils and unhandled
   * promise rejections). On Hermes, the last caller of
   * `enablePromiseRejectionTracker` wins — Hermes has no getter — so another
   * SDK that installs a tracker after this call replaces ours.
   */
  async launch(token: string, options: LaunchOptions = {}): Promise<boolean> {
    assertUsableToken(token);
    // Registered before launching, not after: the SDK reads the wrapper while
    // composing a report's environment, and a crash during start-up would
    // otherwise produce a report that does not say what wrapper it came from.
    this.registerWrapper();
    installExceptionHandlers();
    applyExceptionCaptureFromOptions(options);
    return NativeBugsee.launch(token, options);
  }

  /**
   * Tells the SDK what wrapper it is running under.
   *
   * Idempotent and cheap, so `launch` and `relaunch` can both call it; the
   * SDK replaces whatever was registered.
   */
  private registerWrapper(): void {
    NativeBugsee.setWrapperInfo(
      wrapperIdentity(collectWrapperFacts(PACKAGE_VERSION)),
    );
  }

  /** Restarts an already-launched session with a new set of options. */
  async relaunch(options: LaunchOptions = {}): Promise<boolean> {
    this.registerWrapper();
    installExceptionHandlers();
    applyExceptionCaptureFromOptions(options);
    return NativeBugsee.relaunch(options);
  }

  /**
   * Publishes the regions the SDK must not record on `display`, replacing
   * whatever this method published for it before. An empty list clears them.
   *
   * Regions held by a mounted `<BugseeSecure>` are kept apart and published
   * alongside: clearing here never uncovers a component, and a component
   * unmounting never clears these.
   *
   * Synchronous by design. The SDK PULLS these 2-3 times a second from its own
   * thread and never waits on JS, so there is nothing to await; a promise here
   * would only invite a caller to believe a region was redacted before it was.
   *
   * The whole call is rejected if any rectangle is malformed, rather than the
   * bad one being dropped: publishing the rest would leave the caller believing
   * the missing region is redacted when it is not.
   */
  setSecureRectangles(
    rectangles: readonly SecureRectangle[],
    display: number = 0,
  ): void {
    if (!Number.isInteger(display) || display < 0) {
      throw new RangeError(
        `display must be a non-negative integer, got ${String(display)}; ` +
          `a fractional index reaches the native cast and silently addresses display 0`,
      );
    }
    setOwnerRectangles(`manual:${display}`, display, rectangles);
  }

  /**
   * Suppresses everything that describes the screen: the video (black
   * frames), the report screenshot (black), touch/gesture recording and the
   * view hierarchy. Logs, network events, custom events and traces keep
   * recording throughout (design doc §4.1).
   *
   * Android ignores this before `launch()` resolves -- a logged no-op, not an
   * error -- while iOS honours it regardless of launch state. Call this after
   * `launch()` resolves when blackout must hold on both platforms.
   *
   * {@link isBlackout} verifies whether it actually took effect.
   */
  startBlackout(): void {
    NativeBugsee.startBlackout();
  }

  /** Resumes everything {@link startBlackout} suppressed. */
  endBlackout(): void {
    NativeBugsee.endBlackout();
  }

  /** The current blackout state, as {@link startBlackout} / {@link endBlackout} left it. */
  async isBlackout(): Promise<boolean> {
    return NativeBugsee.isBlackout();
  }

  /** Captures the view hierarchy immediately, outside a normal snapshot pass. */
  captureViewHierarchy(): void {
    NativeBugsee.captureViewHierarchy();
  }

  /**
   * Wraps the app's root component so the SDK can capture the on-screen view
   * hierarchy ("vh") -- the anonymised tree of what is on screen that
   * annotates a bug report or a live capture. Without this, the SDK's view-
   * hierarchy request always comes back empty: there is nothing registered
   * for it to walk.
   *
   * Renders `Root` unchanged, alongside an invisible anchor the view-tree
   * walk uses to find the app's fiber tree; neither is ever drawn on top of
   * the app or intercepts a touch. Usage:
   * `AppRegistry.registerComponent(appName, () => Bugsee.wrap(App))`.
   */
  wrap<P extends object>(Root: ComponentType<P>): ComponentType<P> {
    return wrap(Root);
  }

  /**
   * Subscribes to the SDK's lifecycle events.
   *
   * Events arrive OFF the main thread on both platforms and are delivered to
   * JavaScript as they come; nothing is queued while no subscriber exists, so
   * a subscription made after launch does not replay what it missed. Ask
   * `getStatus()` for the current state rather than reconstructing it.
   *
   * An event this version does not know is delivered unchanged rather than
   * dropped: a newer SDK must be able to reach a subscriber through an older
   * wrapper.
   */
  onLifecycleEvent(
    listener: (event: LifecycleEvent) => void,
  ): { remove: () => void } {
    return NativeBugsee.onLifecycleEvent(listener);
  }

  /**
   * Subscribes to the SDK's status transitions.
   *
   * Derived from the lifecycle channel, not a second native one: Android has
   * no status listener at all and iOS's belongs to the app's own delegate.
   * Only the four transition events produce a call; everything else is
   * silent, because reporting a status for a non-transition would say the SDK
   * had moved when it had not.
   */
  onStatusChange(
    listener: (status: Status) => void,
  ): { remove: () => void } {
    return NativeBugsee.onLifecycleEvent((event: LifecycleEvent) => {
      const status = statusForEvent(event);
      if (status !== undefined) {
        listener(status);
      }
    });
  }

  /** Stops the current session. */
  async stop(): Promise<boolean> {
    return NativeBugsee.stop();
  }

  /**
   * Installs the handler the SDK hands a report to before and/or after it
   * builds one. See `BugseeReportHandler` for the full phase contract.
   *
   * Register before `launch()` to see reports the SDK recovers at launch --
   * a handler installed afterward misses whatever launch already recovered.
   * `null` tells the SDK no phase is wanted; a later call can resume
   * delivery.
   *
   * `onBeforeReportCreated` is at-most-once and may be skipped for a given
   * report; `onAfterReportCreated` is at-least-once and MUST be idempotent
   * (`setLabels`/`setAttribute`, not appending; check `getAttachmentNames()`
   * before adding one). A mutation made after the callback settles, or after
   * its handle's deadline passes -- the SDK's deadline, not one the app
   * negotiates -- does not reach the report.
   *
   * Budgets: 25 s per callback for a live report on both platforms (never
   * raised above that; on Android it follows a lower
   * `report-handler-callback-timeout`). A report recovered at launch gets
   * 2.5 s on iOS (off main, best-effort, edits land only until the bundle is
   * assembled). On Android, a Java uncaught-exception relaunch launched from
   * JS gets the live 25 s on `BugseeReportHandlerThread`. An NDK relaunch,
   * and Android's early bounded recovery, never reach JS. So async I/O in
   * `onAfterReportCreated` can succeed on a Java relaunch and silently miss
   * on iOS recovery or an Android NDK relaunch. Details on
   * `BugseeReportHandler`.
   */
  setReportHandler(handler: BugseeReportHandler | null): void {
    installReportHandler(handler);
  }

  /**
   * Creates and uploads a bug report immediately, without showing any UI.
   *
   * Does nothing before `launch()`. `showReportDialog` runs
   * `onBeforeReportCreated` before the dialog opens.
   *
   * `summary` and `description` must both be strings (an empty string is
   * fine; only the type is checked). Omitted `severity` crosses as `0`,
   * which is the SDK's default. Omitted `labels` cross as `null`. There is
   * no `includeVideo`: a fifth argument throws `TypeError`.
   */
  upload(
    summary: string,
    description: string,
    severity?: IssueSeverity,
    labels?: readonly string[],
  ): void {
    if (arguments.length > 4) {
      throw new TypeError(
        'Bugsee.upload takes at most four arguments; 7.x has no includeVideo',
      );
    }
    if (typeof summary !== 'string') {
      throw new TypeError(
        `Bugsee.upload requires summary to be a string, got ${typeof summary}`,
      );
    }
    if (typeof description !== 'string') {
      throw new TypeError(
        `Bugsee.upload requires description to be a string, got ${typeof description}`,
      );
    }
    NativeBugsee.upload(
      summary,
      description,
      severityArgument(severity, 'upload'),
      labelsArgument(labels, 'upload'),
    );
  }

  /**
   * Shows the bug-report dialog.
   *
   * Does nothing before `launch()`. The dialog runs `onBeforeReportCreated`
   * before it opens.
   *
   * `summary` and `description` are omitted or a string, and cross as `null`
   * when absent. Severity and labels follow `upload`: omitted severity is
   * the SDK default (`0`), omitted labels cross as `null`.
   */
  showReportDialog(
    summary?: string,
    description?: string,
    severity?: IssueSeverity,
    labels?: readonly string[],
  ): void {
    const summaryText = optionalReportText(summary, 'summary');
    const descriptionText = optionalReportText(description, 'description');
    NativeBugsee.showReportDialog(
      summaryText,
      descriptionText,
      severityArgument(severity, 'showReportDialog'),
      labelsArgument(labels, 'showReportDialog'),
    );
  }

  /**
   * One line into the Bugsee log, attributed to the wrapper (source Custom, no
   * tag) and filtered natively by the app's log filter, exactly once. Dropped
   * before launch() -- the channel is inert until then.
   */
  log(message: string, level: LogLevel = LogLevel.Info): void {
    forwardLog(message, level);
  }

  /**
   * Records a named event, with optional params.
   *
   * `params` must be a plain object or omitted entirely -- `null` throws
   * `TypeError`, a change from 6.x, which accepted `null` there as "no
   * params". Pass no second argument (or `undefined`) instead.
   *
   * `params` is validated against the accepted value domain
   * (`src/data/validate.ts`) and copied before it crosses -- a value outside
   * that domain throws synchronously, in JS, rather than reaching native in
   * some guessed-at shape. It crosses as JSON text (`src/bridge/json.ts`), so
   * a `null` member arrives as `null` on both platforms. Omitting `params`
   * sends `null` natively, not `'{}'`: the bundle's event entry has no
   * `params` key at all when none were given.
   */
  event(name: string, params?: EventParams): void {
    assertEventOrTraceName('event', name);
    if (params === undefined) {
      NativeBugsee.event(name, null);
      return;
    }
    NativeBugsee.event(name, encodeBridgeObject(copyEventParams(params)));
  }

  /**
   * Records a named trace value.
   *
   * Dispatches on `typeof value` to one of three typed native methods --
   * `traceNumber`, `traceString` or `traceBoolean` -- rather than one
   * untyped call: codegen has no union parameter type, and an untyped path
   * would let a boolean silently arrive as `0`/`1` on the SDK side. `value`
   * is validated first, so nothing outside the domain reaches any of them.
   */
  trace(name: string, value: TraceValue): void {
    assertEventOrTraceName('trace', name);
    assertTraceValue(value);
    if (typeof value === 'number') {
      NativeBugsee.traceNumber(name, value);
    } else if (typeof value === 'string') {
      NativeBugsee.traceString(name, value);
    } else {
      NativeBugsee.traceBoolean(name, value);
    }
  }

  /**
   * Runs `fn`, translating any rejection into a `BugseeAttributeError`.
   * `fn` validates its own arguments FIRST, synchronously, inside this same
   * async function body -- a synchronous throw there becomes this promise's
   * rejection automatically, so a validation failure never crosses the
   * bridge and never throws synchronously either.
   */
  private async runAttributeOp<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toAttributeError(error);
    }
  }

  /**
   * Sets an attribute, dispatching on `typeof value` to one of three typed
   * native methods -- exactly as {@link trace} does, and for the same
   * reason: there is no untyped bridge parameter a boolean could not
   * silently become `0`/`1` through.
   *
   * Persists across launches. Android stores a fractional or large number as
   * a 32-bit float, so `setAttribute('k', 0.1)` can read back as
   * `0.10000000149011612` -- the value the report itself carries, not a
   * rounding bug in this wrapper. iOS drops a value whose archived size
   * exceeds about 1.1 KB. In practice a string of up to ~800 ASCII
   * characters is safe on both platforms; Android accepts up to 1024 UTF-16
   * units. A string longer than that can be rejected here with
   * `E_ATTRIBUTE_REJECTED` on iOS while the same value is kept on Android.
   */
  async setAttribute(name: string, value: AttributeValue): Promise<void> {
    return this.runAttributeOp(async () => {
      const validName = validateAttributeName(name);
      const validValue = validateAttributeValue(value);
      if (typeof validValue === 'string') {
        await NativeBugsee.setAttributeString(validName, validValue);
      } else if (typeof validValue === 'number') {
        await NativeBugsee.setAttributeNumber(validName, validValue);
      } else {
        await NativeBugsee.setAttributeBoolean(validName, validValue);
      }
    });
  }

  /** One attribute's current value, or `undefined` when it is not set. */
  async getAttribute(name: string): Promise<AttributeReadValue | undefined> {
    return this.runAttributeOp(async () => {
      const validName = validateAttributeName(name);
      const raw = (await NativeBugsee.getAttribute(validName)) as { value?: unknown };
      return normalizeAttributeReadValue(raw?.value);
    });
  }

  /** Every attribute currently set, as the retained report will carry them. */
  async getAllAttributes(): Promise<Record<string, AttributeReadValue>> {
    return this.runAttributeOp(async () => normalizeAttributesMap(await NativeBugsee.getAllAttributes()));
  }

  /** Removes one attribute. A no-op if it was not set. */
  async clearAttribute(name: string): Promise<void> {
    return this.runAttributeOp(async () => {
      const validName = validateAttributeName(name);
      await NativeBugsee.clearAttribute(validName);
    });
  }

  /** Removes every attribute. */
  async clearAllAttributes(): Promise<void> {
    return this.runAttributeOp(() => NativeBugsee.clearAllAttributes());
  }

  /**
   * Sets the user identifier. Synchronous, unlike the attribute methods: no
   * size limit applies to it, so there is nothing a native read-back could
   * usefully reject.
   *
   * `''` clears instead of setting an empty identifier -- both SDKs treat an
   * empty identifier as "no identifier" on read, but only iOS treats SETTING
   * one as a clear; this makes the two consistent.
   */
  setUserIdentifier(identifier: string): void {
    assertIdentifierString(identifier);
    if (identifier.length === 0) {
      NativeBugsee.clearUserIdentifier();
      return;
    }
    NativeBugsee.setUserIdentifier(identifier);
  }

  /** The current user identifier, or `undefined` when none is set. */
  async getUserIdentifier(): Promise<string | undefined> {
    const raw = (await NativeBugsee.getUserIdentifier()) as { value?: unknown };
    return normalizeIdentifier(raw?.value);
  }

  /** Clears the user identifier. */
  clearUserIdentifier(): void {
    NativeBugsee.clearUserIdentifier();
  }

  /**
   * Wires up the JS layer when the native SDK launched itself — on Android,
   * from `com.bugsee.app-token` manifest metadata. Deliberately makes no
   * native launch call; doing so would start a second session.
   *
   * Reads `com.bugsee.option.detect.crash` from the native launch options and
   * applies it before the global handlers are installed (R7). Capture is held
   * off during that read: the default is on, and the read yields, so a render
   * error in the gap would otherwise be reported when the option is false.
   * If the read rejects, capture stays off and the handlers are not installed.
   */
  async attach(): Promise<void> {
    setExceptionCaptureEnabled(false);
    const options = await this.getLaunchOptions();
    applyExceptionCaptureFromOptions(options);
    installExceptionHandlers();
  }

  /**
   * The SDK's current status. An unrecognised native value reports as
   * `Stopped` rather than being passed through, so a newer native SDK adding
   * a state cannot leak a number no JS caller can interpret.
   */
  async getStatus(): Promise<Status> {
    const raw = await NativeBugsee.getStatus();
    return KNOWN_STATUSES.has(raw) ? (raw as Status) : Status.Stopped;
  }

  /** The options the SDK reports as being in effect. */
  async getLaunchOptions(): Promise<Record<string, unknown>> {
    return (await NativeBugsee.getLaunchOptions()) as Record<string, unknown>;
  }

  /**
   * The SDK's own test crash: a Java `RuntimeException` on Android, an
   * `NSException` on iOS. For a real native (signal) crash, see the bare
   * example's native helper package.
   */
  testNativeCrash(): void {
    NativeBugsee.testCrash();
  }

  /** Throws in JS, to verify the JS exception handler is wired up. */
  testJsCrash(): never {
    throw new Error('Bugsee test JS crash');
  }

  /**
   * Reports `error` as a handled error. Before launch() the SDKs drop it.
   * Validates `options` first: a bad option throws synchronously and nothing
   * crosses.
   */
  logException(error: unknown, options?: ExceptionOptions): void {
    encodeExceptionOptions(options);
    if (!markReported(error)) {
      return;
    }
    const extras =
      error instanceof Error
        ? undefined
        : { fallbackStack: dropFirstStackFrame(new Error().stack) };
    reportHandled(error, options, extras);
  }

  /**
   * Reports `error` as a crash; resolves once the SDK has it (at most 1.5 s).
   * iOS surfaces it at the next launch.
   */
  logUnhandledException(error: unknown): Promise<void> {
    if (!markReported(error)) {
      return Promise.resolve();
    }
    const extras =
      error instanceof Error
        ? undefined
        : { fallbackStack: dropFirstStackFrame(new Error().stack) };
    return reportUnhandled(error, extras);
  }
}

/**
 * `stack` with its first frame line removed, so a non-Error logged through the
 * facade has frames that start at the caller rather than at `logException`.
 */
function dropFirstStackFrame(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string' || stack.length === 0) {
    return stack;
  }
  const lines = stack.split('\n');
  let firstFrame = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trimStart();
    if (
      trimmed.startsWith('at ') ||
      trimmed.startsWith('@') ||
      /^[^\s@]+@/.test(trimmed)
    ) {
      firstFrame = i;
      break;
    }
  }
  if (firstFrame === -1) {
    return stack;
  }
  lines.splice(firstFrame, 1);
  return lines.join('\n');
}

function optionalReportText(
  value: unknown,
  name: 'summary' | 'description',
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(
      `Bugsee.showReportDialog requires ${name} to be a string, got ${typeof value}`,
    );
  }
  return value;
}

function assertUsableToken(token: string): void {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Bugsee.launch requires a non-empty app token');
  }
}

export { WRAPPER_TYPE } from './wrapper/identity';
export { PACKAGE_VERSION } from './version';
export { BugseeLaunchOptions } from './options/BugseeLaunchOptions';
export { AndroidLaunchOptions } from './options/AndroidLaunchOptions';
export { IOSLaunchOptions } from './options/IOSLaunchOptions';
export { createDefaultLaunchOptions } from './options/createDefaultLaunchOptions';
export { endpointFor } from './options/endpoint';
export {
  FrameRate,
  IssueSeverity,
  LogLevel,
  VideoMode,
  VideoQuality,
} from './options/enums';

export default new Bugsee();

export type { SecureRectangle } from './secure/rectangles';
export { BugseeSecure } from './secure/BugseeSecure';
export type { BugseeSecureProps } from './secure/BugseeSecure';

export type { LifecycleEvent } from './wrapper/events';

export { ReportErrorCode, BugseeReportError } from './report/errors';
export type {
  BugseeReport,
  BugseeReportHandler,
  BugseeReportSnapshot,
  ReportPatch,
  ReportType,
} from './report/types';

export type { EventParams, EventParamValue, TraceValue } from './data/validate';

export { AttributeErrorCode, BugseeAttributeError } from './attributes/errors';
export type { AttributeReadValue, AttributeValue } from './attributes/validate';

export type { ExceptionOptions } from './exceptions/options';
export { ErrorBoundary } from './exceptions/ErrorBoundary';
export type {
  ErrorBoundaryFallbackProps,
  ErrorBoundaryProps,
} from './exceptions/ErrorBoundary';
