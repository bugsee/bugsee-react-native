import { LogLevel } from '../options/enums';
import { forwardLog } from '../wrapper/channel';

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

/**
 * One console line, the way a console prints several arguments: joined with
 * a space, each argument via `String`. Objects stay `[object Object]` —
 * they are not JSON, so a field that holds a secret is not copied into the
 * log.
 */
function formatConsoleLine(args: readonly unknown[]): string {
  return args.map(arg => String(arg)).join(' ');
}

function patch(method: ConsoleMethod): void {
  const level = LEVEL_BY_METHOD[method];
  const original = console[method].bind(console);
  const wrapped = (...args: unknown[]): void => {
    original(...args);
    if (!forwardEnabled) {
      return;
    }
    forwardLog(formatConsoleLine(args), level);
  };
  console[method] = wrapped as typeof console.log;
}

/**
 * Patches `console.log`, `console.info`, `console.warn`, `console.error`
 * and `console.debug`. Each call still performs the original console call,
 * then forwards one line through `forwardLog` — the only native route.
 * The app's log filter is not run here: every channel line is filtered
 * natively, once.
 *
 * Idempotent. A second call does not wrap the already-patched functions.
 * It does re-read `com.bugsee.option.capture.logs`: `false` stops
 * forwarding, and an absent option leaves forwarding on.
 *
 * An explicit `Bugsee.log` does not go through this patch.
 */
export function installConsoleCapture(options: Record<string, unknown> = {}): void {
  forwardEnabled = options[CAPTURE_LOGS_OPTION] !== false;
  if (installed) {
    return;
  }
  installed = true;
  for (const method of METHODS) {
    patch(method);
  }
}
