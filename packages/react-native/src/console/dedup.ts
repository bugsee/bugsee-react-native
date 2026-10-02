/**
 * Which of the two console streams may reach the user's log filter.
 *
 * Under `__DEV__`, one `console.*` call is seen by the JS patch and by
 * React Native's `RCTLog` (`nativeLoggingHook`). Both streams stay live:
 * the patch is how a release build still records console output (React
 * Native does not route `console.*` through `RCTLog` then, and a Hermes
 * release build often strips the call before `RCTLog` could see it), and
 * `RCTLog` is how RN-internal lines that the patch never sees are recorded.
 *
 * The overlap is removed by dropping the echo, not the patch. Dropping the
 * patch because `RCTLog` "will also see it" would drop release logs.
 */

import { Platform } from 'react-native';

/** How long an echo claim can still suppress a second filter pass. */
export const ECHO_WINDOW_MS = 2_000;

const MAX_CLAIMS = 32;

interface Stamp {
  text: string;
  expires: number;
  /**
   * Equal text is the patch, the echo, `Bugsee.log`, and a native line.
   * Android drops the logcat echo before JS is asked, so this is cleared
   * when the patch is delivered. iOS still delivers one unstamped stderr
   * copy; this stays set until that copy is dropped, and then a later
   * equal line is kept. os_log capture is disabled. This package does not
   * forward `RCTLogSourceJavaScript`.
   */
  exact: boolean;
  /** A stderr stamp can still be dropped after the equal-text copy is handled. */
  stamp: boolean;
}

const echoes: Stamp[] = [];
const protectedLines: Stamp[] = [];

/** `__DEV__` when the runtime defined it, otherwise a release-shaped build. */
export function readDev(): boolean {
  const devFlag = (globalThis as { __DEV__?: unknown }).__DEV__;
  return typeof devFlag === 'boolean' ? devFlag : false;
}

/**
 * The JS patch forwards in dev and in release. A build that forwarded only
 * in one of them would either double-filter dev or drop release.
 */
export function shouldForwardJsPatch(dev: boolean): boolean {
  const inDev = dev;
  const inRelease = !dev;
  return inDev || inRelease;
}

/**
 * The RCTLog echo of a call the patch is forwarding. Dropped in dev, where
 * that overlap exists, and in release if the echo is still produced: the
 * patch already has the line. An RCTLog line the patch does not own (RN
 * core, a native module) is not an echo and is kept.
 */
export function shouldDropConsoleEcho(dev: boolean, patchOwnsCall: boolean): boolean {
  if (!patchOwnsCall) {
    return false;
  }
  const inDev = dev;
  const inRelease = !dev;
  return inDev || inRelease;
}

/**
 * iOS still delivers one unstamped stderr copy of the console line, plus the
 * stamp. Android drops the logcat echo before JS is asked, so the equal-text
 * claim dies with the patch. os_log capture stays disabled; this package
 * does not forward `RCTLogSourceJavaScript`.
 */
function equalEchoReachesJs(): boolean {
  return Platform.OS === 'ios';
}

function retireExact(text: string): void {
  if (equalEchoReachesJs()) {
    return;
  }
  const echoAt = echoes.findIndex((stamp) => stamp.exact && stamp.text === text);
  if (echoAt === -1) {
    return;
  }
  const echo = echoes[echoAt]!;
  echo.exact = false;
  if (!echo.stamp) {
    echoes.splice(echoAt, 1);
  }
}

function prune(list: Stamp[], now: number): void {
  let index = 0;
  while (index < list.length) {
    const stamp = list[index]!;
    if (stamp.expires <= now) {
      if (list === protectedLines) {
        retireExact(stamp.text);
      }
      list.splice(index, 1);
    } else {
      index += 1;
    }
  }
  while (list.length > MAX_CLAIMS) {
    list.shift();
  }
}

/** The text `nativeLoggingHook` actually emitted for this console call. */
export function claimEcho(message: string, now: number = Date.now()): void {
  echoes.push({ text: message, expires: now + ECHO_WINDOW_MS, exact: true, stamp: true });
  while (echoes.length > MAX_CLAIMS) {
    echoes.shift();
  }
}

/** The line the JS patch is about to forward. That copy reaches the filter. */
export function protectLine(line: string, now: number = Date.now()): void {
  protectedLines.push({ text: line, expires: now + ECHO_WINDOW_MS, exact: false, stamp: false });
  while (protectedLines.length > MAX_CLAIMS) {
    protectedLines.shift();
  }
}

/**
 * A stderr line the iOS SDK stored as
 * `2026-10-02 18:40:35.273 BareExample[60839:42420530] <message>`.
 * The stamp is a different string from the patch, so dropping it does not
 * retire the equal-text claim. iOS also delivers one unstamped stderr copy
 * of the same text; that copy is dropped separately and then the claim
 * dies. os_log capture is disabled. Android's logcat echo is dropped in
 * the bridge before JS is asked.
 */
export function isConsoleStampOf(line: string, message: string): boolean {
  const tail = `] ${message}`;
  if (message.length === 0 || !line.endsWith(tail)) {
    return false;
  }
  const head = line.slice(0, line.length - tail.length);
  const splitAt = head.indexOf('[');
  if (splitAt <= 0) {
    return false;
  }
  const when = head.slice(0, splitAt);
  const pid = head.slice(splitAt + 1);
  return (
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ [^\s[]+$/.test(when) && /^\d+:\d+$/.test(pid)
  );
}

/**
 * `deliver` runs the user's filter. `drop` answers the native request with
 * null and does not call the user.
 *
 * Android: the equal-text claim dies when the patch is delivered, because
 * the logcat echo was dropped in the bridge and will not reach JS. A later
 * `Bugsee.log`, native line, or second `console.*` of that string is kept.
 * iOS: the SDK still delivers one unstamped stderr copy. That copy is the
 * echo; dropping it ends the claim. The stamp is dropped too, and dropping
 * the stamp does not end the claim early. os_log capture is disabled.
 */
export function classifyFilterRequest(
  line: string,
  now: number = Date.now(),
): 'deliver' | 'drop' {
  prune(protectedLines, now);
  prune(echoes, now);
  const stampAt = echoes.findIndex(
    (stamp) => stamp.stamp && isConsoleStampOf(line, stamp.text),
  );
  if (stampAt !== -1) {
    const echo = echoes[stampAt]!;
    echo.stamp = false;
    if (!echo.exact) {
      echoes.splice(stampAt, 1);
    }
    return 'drop';
  }
  const protectAt = protectedLines.findIndex((stamp) => stamp.text === line);
  if (protectAt !== -1) {
    protectedLines.splice(protectAt, 1);
    retireExact(line);
    return 'deliver';
  }
  const echoAt = echoes.findIndex((stamp) => stamp.exact && stamp.text === line);
  if (echoAt !== -1) {
    const echo = echoes[echoAt]!;
    echo.exact = false;
    if (!echo.stamp) {
      echoes.splice(echoAt, 1);
    }
    return 'drop';
  }
  return 'deliver';
}

/** Tests start from an empty ledger. Production never calls this. */
export function resetConsoleDedup(): void {
  echoes.length = 0;
  protectedLines.length = 0;
}
