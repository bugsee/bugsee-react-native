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

interface Claim {
  text: string;
  expires: number;
}

/**
 * Equal text and the stderr stamp are separate claims. Delivering the patch
 * removes the equal-text claim on both platforms: Android already dropped
 * the logcat echo, and iOS does not forward `RCTLogSourceJavaScript`.
 * os_log capture is disabled, so there is no unstamped stderr copy to wait
 * for. The stamp is a different string and is dropped on its own.
 */
const exactEchoes = new Array<Claim>();
const stampEchoes = new Array<Claim>();
const protectedLines = new Array<Claim>();

/** `__DEV__` when the runtime defined it, otherwise a release-shaped build. */
export function readDev(): boolean {
  const devFlag = (globalThis as { __DEV__?: unknown }).__DEV__;
  return typeof devFlag === 'boolean' ? devFlag : false;
}

/**
 * The JS patch forwards in dev and in release. A build that forwarded only
 * in one of them would either double-filter dev or drop release.
 */
// The build flag is part of the signature. Both values forward.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shouldForwardJsPatch(dev: boolean): boolean {
  // Dev and release both forward. The argument stays so a caller cannot
  // select one build and skip the other.
  return true;
}

/**
 * The RCTLog echo of a call the patch is forwarding. Dropped in dev, where
 * that overlap exists, and in release if the echo is still produced: the
 * patch already has the line. An RCTLog line the patch does not own (RN
 * core, a native module) is not an echo and is kept.
 */
export function shouldDropConsoleEcho(dev: boolean, patchOwnsCall: boolean): boolean {
  // The echo is dropped in dev and in release. Only whether the patch owns
  // the call changes the answer.
  return patchOwnsCall;
}

/**
 * The equal-text claim dies with the patch. No unstamped echo of that line
 * reaches JS: Android drops it in the bridge, and iOS writes only os_log of
 * the raw message while this package skips `RCTLogSourceJavaScript`.
 */
function retireExact(text: string): void {
  const echoAt = exactEchoes.findIndex((claim) => claim.text === text);
  if (echoAt !== -1) {
    exactEchoes.splice(echoAt, 1);
  }
}

function prune(list: Claim[], now: number): void {
  let index = 0;
  while (index < list.length) {
    const claim = list[index]!;
    if (claim.expires <= now) {
      if (list === protectedLines) {
        retireExact(claim.text);
      }
      list.splice(index, 1);
    } else {
      index += 1;
    }
  }
}

function remember(list: Claim[], text: string, now: number): void {
  list.push({ text, expires: now + ECHO_WINDOW_MS });
  while (list.length > MAX_CLAIMS) {
    list.shift();
  }
}

/** The text `nativeLoggingHook` actually emitted for this console call. */
export function claimEcho(message: string, now: number = Date.now()): void {
  remember(exactEchoes, message, now);
  remember(stampEchoes, message, now);
}

/** The line the JS patch is about to forward. That copy reaches the filter. */
export function protectLine(line: string, now: number = Date.now()): void {
  remember(protectedLines, line, now);
}

/**
 * A stderr line the iOS SDK stored as
 * `2026-10-02 18:40:35.273 BareExample[60839:42420530] <message>`.
 * The stamp is a different string from the patch. Dropping it does not
 * retire the equal-text claim; delivering the patch does. os_log capture
 * is disabled, and this package does not wait for an unstamped stderr
 * copy. Android's logcat echo is dropped in the bridge before JS is asked.
 */
export function isConsoleStampOf(line: string, message: string): boolean {
  const tail = `] ${message}`;
  if (message.length === 0 || !line.endsWith(tail)) {
    return false;
  }
  const head = line.slice(0, line.length - tail.length);
  const splitAt = head.indexOf('[');
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
 * The equal-text claim dies when the patch is delivered, on Android and
 * on iOS. A later `Bugsee.log`, native line, or second `console.*` of that
 * string is kept. An echo that is actually classified — a stderr stamp, or
 * an equal line that arrives while the claim is still live — is dropped
 * once. os_log capture is disabled. There is no unstamped stderr copy to
 * wait for.
 */
export function classifyFilterRequest(
  line: string,
  now: number = Date.now(),
): 'deliver' | 'drop' {
  prune(protectedLines, now);
  prune(exactEchoes, now);
  prune(stampEchoes, now);
  const stampAt = stampEchoes.findIndex((claim) => isConsoleStampOf(line, claim.text));
  if (stampAt !== -1) {
    stampEchoes.splice(stampAt, 1);
    return 'drop';
  }
  const protectAt = protectedLines.findIndex((claim) => claim.text === line);
  if (protectAt !== -1) {
    protectedLines.splice(protectAt, 1);
    retireExact(line);
    return 'deliver';
  }
  const echoAt = exactEchoes.findIndex((claim) => claim.text === line);
  if (echoAt !== -1) {
    exactEchoes.splice(echoAt, 1);
    return 'drop';
  }
  return 'deliver';
}

/** Tests start from an empty ledger. Production never calls this. */
export function resetConsoleDedup(): void {
  exactEchoes.length = 0;
  stampEchoes.length = 0;
  protectedLines.length = 0;
}
