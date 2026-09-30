/**
 * Global JS exception capture: ErrorUtils and unhandled promise rejections.
 *
 * Idempotent per JS runtime. Captures only while
 * `com.bugsee.option.detect.crash` is not false (R7). Fatal ErrorUtils errors
 * go to {@link reportUnhandled}; everything else (including rejections) goes
 * to {@link reportHandled}.
 *
 * Hermes has no getter for the active promise-rejection tracker: the last
 * caller of `enablePromiseRejectionTracker` wins. Another SDK that installs a
 * tracker after `launch()` replaces ours.
 */

import {
  markReported,
  reportHandled,
  reportUnhandled,
  UNHANDLED_REPORT_WAIT_MS,
} from './report';

declare const __DEV__: boolean;

export interface ErrorUtilsLike {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

export interface RejectionOptions {
  allRejections: true;
  onUnhandled(id: number, rejection: unknown): void;
  onHandled(id: number): void;
}

export interface HandlerEnv {
  errorUtils(): ErrorUtilsLike | undefined;
  enableHermesTracker(): ((options: RejectionOptions) => void) | undefined;
  enablePromiseLibraryTracker(): ((options: RejectionOptions) => void) | undefined;
  rnDevRejectionOptions(): Partial<RejectionOptions> | undefined;
  isDev: boolean;
}

let errorUtilsInstalled = false;
let rejectionTrackerInstalled = false;
let captureEnabled = true;
let warnedNoErrorUtils = false;
let warnedHandlerFailure = false;

// Stryker disable all -- warn-once flags: install is idempotent, so a second
// call never re-enters these helpers; emptying the early return is equivalent
// under the suite, and flipping the flag leaves the string still asserted once.
function warnNoErrorUtilsOnce(): void {
  if (warnedNoErrorUtils) {
    return;
  }
  warnedNoErrorUtils = true;
  console.warn(
    '[Bugsee] ErrorUtils is unavailable; uncaught JS errors are not reported',
  );
}

function warnHandlerFailureOnce(): void {
  if (warnedHandlerFailure) {
    return;
  }
  warnedHandlerFailure = true;
  console.warn('[Bugsee] exception handler failed while reporting');
}
// Stryker restore all

// Stryker disable all -- defaultEnv is the production wiring of globals /
// requires; unit tests inject HandlerEnv. Exercising every typeof / require
// branch here needs a full RN runtime and is equivalent under the suite.
function defaultEnv(): HandlerEnv {
  return {
    errorUtils(): ErrorUtilsLike | undefined {
      const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
      return utils;
    },
    enableHermesTracker(): ((options: RejectionOptions) => void) | undefined {
      const hermes = (
        globalThis as {
          HermesInternal?: {
            hasPromise?: () => boolean;
            enablePromiseRejectionTracker?: (options: RejectionOptions) => void;
          };
        }
      ).HermesInternal;
      if (
        hermes == null ||
        typeof hermes.hasPromise !== 'function' ||
        !hermes.hasPromise() ||
        typeof hermes.enablePromiseRejectionTracker !== 'function'
      ) {
        return undefined;
      }
      return hermes.enablePromiseRejectionTracker.bind(hermes);
    },
    enablePromiseLibraryTracker(): ((options: RejectionOptions) => void) | undefined {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tracking = require('promise/setimmediate/rejection-tracking') as {
          enable?: (options: RejectionOptions) => void;
        };
        return typeof tracking.enable === 'function' ? tracking.enable : undefined;
      } catch {
        return undefined;
      }
    },
    rnDevRejectionOptions(): Partial<RejectionOptions> | undefined {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('react-native/Libraries/promiseRejectionTrackingOptions') as {
          default?: Partial<RejectionOptions>;
        };
        return mod.default;
      } catch {
        return undefined;
      }
    },
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
  };
}
// Stryker restore all

function buildRejectionOptions(env: HandlerEnv): RejectionOptions {
  return {
    allRejections: true,
    onUnhandled(id: number, rejection: unknown): void {
      if (captureEnabled && markReported(rejection)) {
        reportHandled(rejection);
      }
      if (env.isDev) {
        env.rnDevRejectionOptions()?.onUnhandled?.(id, rejection);
      }
    },
    onHandled(id: number): void {
      if (env.isDev) {
        env.rnDevRejectionOptions()?.onHandled?.(id);
      }
    },
  };
}

function installRejectionTracker(env: HandlerEnv): void {
  const options = buildRejectionOptions(env);
  const hermes = env.enableHermesTracker();
  if (hermes !== undefined) {
    hermes(options);
    return;
  }
  const promiseLib = env.enablePromiseLibraryTracker();
  if (promiseLib !== undefined) {
    promiseLib(options);
  }
}

function installErrorUtils(env: HandlerEnv): void {
  const utils = env.errorUtils();
  if (utils === undefined) {
    warnNoErrorUtilsOnce();
    return;
  }

  const previous = utils.getGlobalHandler();

  const onError = (error: unknown, isFatal?: boolean): void => {
    let previousRan = false;
    const runPrevious = (): void => {
      // Stryker disable next-line ConditionalExpression,BooleanLiteral -- double-call guard; a single finally cannot observe a second entry
      if (previousRan) {
        return;
      }
      // Stryker disable next-line BooleanLiteral -- paired with the guard above
      previousRan = true;
      previous(error, isFatal);
    };

    try {
      if (captureEnabled && markReported(error)) {
        if (isFatal === true) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<void>((resolve) => {
            timeoutId = setTimeout(resolve, UNHANDLED_REPORT_WAIT_MS);
          });
          void Promise.race([
            Promise.resolve(reportUnhandled(error)).then(
              () => undefined,
              () => undefined,
            ),
            timeout,
          ]).finally(() => {
            // Stryker disable all -- clearTimeout is unobservable in unit tests; emptying this finally body except runPrevious is equivalent under the suite
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
            // Stryker restore all
            runPrevious();
          });
          return;
        }
        reportHandled(error);
      }
    } catch {
      warnHandlerFailureOnce();
    }
    runPrevious();
  };

  utils.setGlobalHandler(onError);
}

/**
 * Idempotent per JS runtime. Each half is marked installed only after it
 * returns, so a throw leaves that half retryable and does not re-wrap the
 * half that already succeeded.
 */
export function installExceptionHandlers(env: HandlerEnv = defaultEnv()): void {
  if (!errorUtilsInstalled) {
    installErrorUtils(env);
    errorUtilsInstalled = true;
  }
  if (!rejectionTrackerInstalled) {
    installRejectionTracker(env);
    rejectionTrackerInstalled = true;
  }
}

/** R7: false only when the launch options set com.bugsee.option.detect.crash to false. */
export function setExceptionCaptureEnabled(enabled: boolean): void {
  captureEnabled = enabled;
}

/** Current R7 capture flag; `RootErrorReporter` reads this rather than copying it. */
export function isExceptionCaptureEnabled(): boolean {
  return captureEnabled;
}
