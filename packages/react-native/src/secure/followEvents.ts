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

type Module = Record<string, unknown>;

// Each require may throw; an empty catch leaves nothing followed, as the missing source does. Metro bundles
// only literal requires, so each is spelled out.
// Stryker disable all
/* eslint-disable @typescript-eslint/no-require-imports -- React Native's internals, where they are */
function load(get: () => unknown): unknown {
  try {
    return get();
  } catch {
    return undefined;
  }
}

followDrivers({
  eventClass: load(() => (require('react-native/Libraries/Animated/AnimatedEvent') as Module).AnimatedEvent),
  implementation: load(() => (require('react-native/Libraries/Animated/AnimatedImplementation') as Module).default),
  exported: load(() => (require('react-native/Libraries/Animated/Animated') as Module).default),
  valueClass: load(() => (require('react-native/Libraries/Animated/nodes/AnimatedValue') as Module).default),
});
/* eslint-enable @typescript-eslint/no-require-imports */
// Stryker restore all
