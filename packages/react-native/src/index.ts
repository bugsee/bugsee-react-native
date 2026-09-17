import NativeBugsee from './NativeBugsee';

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
    return NativeBugsee.launch(token, options);
  }

  /** Restarts an already-launched session with a new set of options. */
  async relaunch(options: LaunchOptions = {}): Promise<boolean> {
    return NativeBugsee.relaunch(options);
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

export default new Bugsee();
