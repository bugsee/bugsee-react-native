import NativeBugsee from './NativeBugsee';
import { PACKAGE_VERSION } from './version';
import { collectWrapperFacts } from './wrapper/collect';
import { wrapperIdentity } from './wrapper/identity';
import { flattenSecureRectangles } from './secure/rectangles';
import type { SecureRectangle } from './secure/rectangles';

/**
 * Mirrors the SDKs' own status enum. Both platforms bring capture up off the
 * main thread, so `launch` returning is not the same as being live — poll or
 * observe this rather than assuming.
 */
export const Status = {
  Stopped: 0,
  Launching: 1,
  Launched: 2,
  Stopping: 3,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

const KNOWN_STATUSES: ReadonlySet<number> = new Set(Object.values(Status));

export type LaunchOptions = Record<string, unknown>;

class Bugsee {
  /**
   * Starts the SDK. Resolves to whether the native side actually launched —
   * it can decline (already running, token rejected) without that being an
   * error the caller should throw on.
   */
  async launch(token: string, options: LaunchOptions = {}): Promise<boolean> {
    assertUsableToken(token);
    // Registered before launching, not after: the SDK reads the wrapper while
    // composing a report's environment, and a crash during start-up would
    // otherwise produce a report that does not say what wrapper it came from.
    this.registerWrapper();
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
    return NativeBugsee.relaunch(options);
  }

  /**
   * Publishes the regions the SDK must not record on `display`, replacing
   * whatever was published for it before. An empty list clears them.
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
    NativeBugsee.setSecureRectangles(display, flattenSecureRectangles(rectangles));
  }

  /** Stops the current session. */
  async stop(): Promise<boolean> {
    return NativeBugsee.stop();
  }

  /**
   * Wires up the JS layer when the native SDK launched itself — on Android,
   * from `com.bugsee.app-token` manifest metadata. Deliberately makes no
   * native launch call; doing so would start a second session.
   *
   * A no-op today: the JS-side components it will wire (console, exceptions,
   * network, lifecycle) do not exist yet. It carries no `attached` flag,
   * because the guard that matters — not registering global handlers twice —
   * belongs in those components, where the double registration would happen,
   * not in a facade field nothing reads.
   */
  async attach(): Promise<void> {}

  /**
   * The SDK's current status. An unrecognised native value reports as
   * `Stopped` rather than being passed through, so a newer native SDK adding
   * a state cannot leak a number no JS caller can interpret.
   */
  async getStatus(): Promise<Status> {
    const raw = await NativeBugsee.getStatus();
    return KNOWN_STATUSES.has(raw) ? (raw as Status) : Status.Stopped;
  }

  /**
   * The options the SDK reports as being in effect.
   *
   * What that means differs by platform, and the difference is not hidden:
   * Android merges its own defaults with the app's overrides and answers even
   * before launch; iOS reports only what differs from its defaults, so an
   * option the app never set is absent there (bugsee/bugsee-cocoa#100).
   */
  async getLaunchOptions(): Promise<Record<string, unknown>> {
    return (await NativeBugsee.getLaunchOptions()) as Record<string, unknown>;
  }

  /** Crashes natively, to verify crash reporting is wired up. */
  testNativeCrash(): void {
    NativeBugsee.testCrash();
  }

  /** Throws in JS, to verify the JS exception handler is wired up. */
  testJsCrash(): never {
    throw new Error('Bugsee test JS crash');
  }
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
