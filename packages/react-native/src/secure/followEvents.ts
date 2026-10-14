/**
 * Starts following what drives native `Animated` values (`drivers.ts`) as
 * soon as it is evaluated. The package entry imports it for its effect alone,
 * which Metro's `inlineRequires` leaves eager: an event attached by a screen
 * that mounts before the app's first `<BugseeSecure>` is counted too. Events
 * attached before the package is first imported are not seen; their values
 * are unknown, and not trusted.
 *
 * React Native's own modules, where an app has them; anywhere they cannot be
 * loaded (a test environment, or React Native moved them), nothing is
 * followed, and no still native value is trusted.
 */
import { followDrivers } from './drivers';

// Each require may throw; an empty catch leaves nothing followed, as the missing source does.
// Stryker disable all
function load(path: string, field: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- React Native's internals, where they are
    return (require(path) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

followDrivers({
  eventClass: load('react-native/Libraries/Animated/AnimatedEvent', 'AnimatedEvent'),
  implementation: load('react-native/Libraries/Animated/AnimatedImplementation', 'default'),
  exported: load('react-native/Libraries/Animated/Animated', 'default'),
  valueClass: load('react-native/Libraries/Animated/nodes/AnimatedValue', 'default'),
});
// Stryker restore all
