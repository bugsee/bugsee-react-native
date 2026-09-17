/**
 * Launch options, keyed by the SDKs' real 7.x option keys.
 *
 * Both platforms accept the same `com.bugsee.option.*` namespace in 7.x, so
 * there is no translation layer here and no per-platform key mapping — the map
 * IS the payload. That is what makes {@link BugseeLaunchOptions.setCustomOption}
 * genuinely useful: a custom key and a first-class accessor write to the same
 * namespace, so an option the wrapper has not surfaced yet, including one added
 * in a future 7.x patch, is reachable with no wrapper release.
 *
 * Subclasses add the accessors for their platform; see `AndroidLaunchOptions`
 * and `IOSLaunchOptions`.
 */
export abstract class BugseeLaunchOptions {
  /** Sent to the native SDK verbatim. */
  private readonly nativeOptions = new Map<string, unknown>();

  /**
   * JS-only settings for the wrapper's own components, kept in a separate map
   * so they cannot reach the native payload. The native SDK never agreed to
   * these keys; one arriving there is at best ignored and at worst rejects the
   * launch.
   */
  private readonly localOptions = new Map<string, unknown>();

  /**
   * Writes a native option. `undefined` **deletes** the key rather than
   * storing an empty value: the payload must not carry a key the caller meant
   * to leave alone, or the native side takes it as an explicit override of the
   * SDK's own default.
   */
  protected $set(key: string, value: unknown): void {
    if (value === undefined) {
      this.nativeOptions.delete(key);
      return;
    }
    this.nativeOptions.set(key, value);
  }

  protected $get<T>(key: string): T | undefined {
    return this.nativeOptions.get(key) as T | undefined;
  }

  /** Writes a JS-only option. `undefined` deletes, as with {@link $set}. */
  protected $setLocal(key: string, value: unknown): void {
    if (value === undefined) {
      this.localOptions.delete(key);
      return;
    }
    this.localOptions.set(key, value);
  }

  protected $getLocal<T>(key: string): T | undefined {
    return this.localOptions.get(key) as T | undefined;
  }

  /**
   * Sets any option by its real `com.bugsee.option.*` key, surfaced or not.
   * `undefined` deletes, exactly as a first-class accessor does.
   */
  setCustomOption(key: string, value: unknown): void {
    this.$set(key, value);
  }

  /**
   * The native payload: a plain object, snapshotted. Callers hold on to the
   * result, so handing back a live view of the map would let a later write
   * change a payload that was already sent.
   */
  static serialize(options: BugseeLaunchOptions): Record<string, unknown> {
    return Object.fromEntries(options.nativeOptions);
  }

  /** The JS-only settings, handed to the wrapper's components separately. */
  static localSettings(options: BugseeLaunchOptions): Record<string, unknown> {
    return Object.fromEntries(options.localOptions);
  }
}
