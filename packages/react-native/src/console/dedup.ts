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

/** How long an echo claim can still suppress a second filter pass. */
export const ECHO_WINDOW_MS = 2_000;

const MAX_CLAIMS = 32;

interface Stamp {
  text: string;
  expires: number;
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

function prune(list: Stamp[], now: number): void {
  let index = 0;
  while (index < list.length) {
    const stamp = list[index]!;
    if (stamp.expires <= now) {
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
  echoes.push({ text: message, expires: now + ECHO_WINDOW_MS });
  while (echoes.length > MAX_CLAIMS) {
    echoes.shift();
  }
}

/** The line the JS patch is about to forward. That copy reaches the filter. */
export function protectLine(line: string, now: number = Date.now()): void {
  protectedLines.push({ text: line, expires: now + ECHO_WINDOW_MS });
  while (protectedLines.length > MAX_CLAIMS) {
    protectedLines.shift();
  }
}

/**
 * iOS captures the console echo from the unified log, and the line the
 * filter sees is the console stamp plus the message:
 * `2026-10-02 18:40:35.273 BareExample[60839:42420530] <message>`.
 * The JS patch's copy is the message alone. Android's logcat echo keeps the
 * message and puts the tag on the side, so an exact compare is enough there.
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
 * null and does not call the user: it is the echo of a line already
 * protected. A protected line wins over an echo claim of the same text, so
 * the patch's copy is the one the filter sees.
 */
export function classifyFilterRequest(
  line: string,
  now: number = Date.now(),
): 'deliver' | 'drop' {
  prune(protectedLines, now);
  prune(echoes, now);
  const protectAt = protectedLines.findIndex((stamp) => stamp.text === line);
  if (protectAt !== -1) {
    protectedLines.splice(protectAt, 1);
    return 'deliver';
  }
  const echoAt = echoes.findIndex((stamp) => stamp.text === line);
  if (echoAt !== -1) {
    echoes.splice(echoAt, 1);
    return 'drop';
  }
  // The console stamp is a second echo of the same call. Dropping it must
  // leave the claim: iOS also delivers the message with no stamp, and that
  // copy is the one this claim exists to suppress.
  if (echoes.some((stamp) => isConsoleStampOf(line, stamp.text))) {
    return 'drop';
  }
  return 'deliver';
}

/** Tests start from an empty ledger. Production never calls this. */
export function resetConsoleDedup(): void {
  echoes.length = 0;
  protectedLines.length = 0;
}
