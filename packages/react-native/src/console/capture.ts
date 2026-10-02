import { LogLevel } from '../options/enums';
import { forwardLog } from '../wrapper/channel';
import {
  claimEcho,
  protectLine,
  readDev,
  shouldDropConsoleEcho,
  shouldForwardJsPatch,
} from './dedup';

/**
 * The launch option that turns console forwarding off. Absent means on,
 * which is the SDK default. Read on every install, including a second one:
 * the functions are wrapped only once, but a later `launch` / `relaunch` /
 * `attach` can still stop or resume forwarding.
 */
const CAPTURE_LOGS_OPTION = 'com.bugsee.option.capture.logs';

const METHODS = ['error', 'warn', 'log', 'info', 'debug'] as const;
type ConsoleMethod = (typeof METHODS)[number];

/**
 * `console.error` → Error (1), `warn` → Warning (2), `log` and `info` →
 * Info (3), `debug` → Debug (4). There is no `console.trace` mapping.
 */
const LEVEL_BY_METHOD: Record<ConsoleMethod, LogLevel> = {
  error: LogLevel.Error,
  warn: LogLevel.Warning,
  log: LogLevel.Info,
  info: LogLevel.Info,
  debug: LogLevel.Debug,
};

let installed = false;
let forwardEnabled = true;
/** Set around the original console call when this patch will also forward. */
let expectingEcho = false;

interface NativeLoggingHost {
  nativeLoggingHook?: (message: string, level: number) => void;
}

interface WrappedHook {
  (message: string, level: number): void;
  bugseeConsoleHook?: boolean;
}

function loggingHost(): NativeLoggingHost {
  return globalThis as NativeLoggingHost;
}

/**
 * Wraps `nativeLoggingHook` once. The original hook still runs, so logcat
 * and the Xcode console keep the line. While this patch is inside a console
 * call it will forward, the hook's message is claimed before the original
 * hook runs. That is before logcat is written, so the claim exists when the
 * echo is filtered, even if the channel line has not been noted yet.
 */
function installNativeHook(): void {
  const host = loggingHost();
  const current = host.nativeLoggingHook;
  if (typeof current !== 'function' || isWrappedHook(current)) {
    return;
  }
  const wrapped: WrappedHook = (message: string, level: number): void => {
    if (expectingEcho) {
      expectingEcho = false;
      claimEcho(message);
    }
    current(message, level);
  };
  wrapped.bugseeConsoleHook = true;
  host.nativeLoggingHook = wrapped;
}

function isWrappedHook(
  hook: (message: string, level: number) => void,
): hook is WrappedHook {
  return (hook as WrappedHook).bugseeConsoleHook === true;
}

/**
 * One argument, via `String`. That is the success path, including functions.
 * `String` throws for a null-prototype object and for a throwing `toString`
 * / `valueOf`. The fallback is the ordinary tag, which does not copy fields.
 */
function stringifyArg(arg: unknown): string {
  try {
    return String(arg);
  } catch {
    return Object.prototype.toString.call(arg);
  }
}

/**
 * One console line, the way a console prints several arguments: joined with
 * a space. Objects that `String` can convert stay `[object Object]` — they
 * are not JSON, so a field that holds a secret is not copied into the log.
 */
function formatConsoleLine(args: readonly unknown[]): string {
  // A loop, not map+join: the intermediate array showed up on this hot path.
  let result = '';
  let first = true;
  for (const arg of args) {
    result += (first ? '' : ' ') + stringifyArg(arg);
    first = false;
  }
  return result;
}

function patch(method: ConsoleMethod): void {
  const level = LEVEL_BY_METHOD[method];
  const original = console[method].bind(console);
  const wrapped = (...args: unknown[]): void => {
    const dev = readDev();
    const owns = forwardEnabled && shouldForwardJsPatch(dev);
    const dropEcho = shouldDropConsoleEcho(dev, owns);
    let line: string | undefined;
    if (owns) {
      try {
        line = formatConsoleLine(args);
      } catch {
        line = undefined;
      }
    }
    if (dropEcho && line !== undefined) {
      expectingEcho = true;
    }
    try {
      original(...args);
    } finally {
      expectingEcho = false;
    }
    if (!owns || line === undefined) {
      return;
    }
    // Formatting or the channel can throw. The original call has already
    // run; this wrap must not turn that into an uncaught exception.
    try {
      if (dropEcho) {
        protectLine(line);
      }
      forwardLog(line, level);
    } catch {
      // Drop the line. The console call itself succeeded.
    }
  };
  console[method] = wrapped as typeof console.log;
}

/**
 * Patches `console.log`, `console.info`, `console.warn`, `console.error`
 * and `console.debug`. Each call still performs the original console call,
 * then forwards one line through `forwardLog` — the only native route for
 * the patch. The app's log filter is not run here. Under `__DEV__` the
 * same call also reaches `RCTLog`; that echo is claimed so the filter
 * runs once. The patch still forwards in release: `RCTLog` does not carry
 * `console.*` there.
 *
 * Idempotent. A second call does not wrap the already-patched functions.
 * It does re-read `com.bugsee.option.capture.logs`: `false` stops
 * forwarding, and an absent option leaves forwarding on.
 *
 * An explicit `Bugsee.log` does not go through this patch.
 */
export function installConsoleCapture(options: Record<string, unknown> = {}): void {
  forwardEnabled = options[CAPTURE_LOGS_OPTION] !== false;
  installNativeHook();
  if (installed) {
    return;
  }
  installed = true;
  for (const method of METHODS) {
    patch(method);
  }
}
