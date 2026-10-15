/**
 * Starts following what drives native `Animated` values (`drivers.ts`) as
 * soon as it is evaluated. The package entry imports it for its effect alone,
 * which Metro's `inlineRequires` leaves eager from the entry's first
 * evaluation: with `inlineRequires`, that is the app's first use of
 * `@bugsee/react-native` (import it, or call `Bugsee.launch`, at the top of
 * `index.js` to follow from the start). An event attached by a screen that
 * mounts before then is not seen; the value it drives was made native
 * unfollowed, so it is not trusted until JS next animates or sets it.
 *
 * React Native's own modules, where an app has them; anywhere they cannot be
 * loaded (a test environment, or React Native moved them), nothing is
 * followed, and no still native value is trusted.
 *
 * Each `require` has a literal path (Metro bundles nothing else) and sits
 * directly in a `try` block: Metro then takes it as an optional dependency
 * (`allowOptionalDependencies`, on by default in React Native's and Expo's
 * Metro configs), so a file a future React Native moved builds into the
 * bundle as a `require` that throws at startup, caught here, rather than
 * failing the build. An app that turns optional dependencies off would fail
 * its build instead; `scripts/check-rn-compat.sh` guards the four paths on
 * every supported React Native first.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- React Native's internals, where they are */
import { followDrivers } from './drivers';

type Module = Record<string, unknown>;

// An empty catch leaves that source missing, which follows nothing.
// Stryker disable all
let eventClass: unknown;
try {
  eventClass = (require('react-native/Libraries/Animated/AnimatedEvent') as Module).AnimatedEvent;
} catch {
  // Not there: nothing followed.
}
let implementation: unknown;
try {
  implementation = (require('react-native/Libraries/Animated/AnimatedImplementation') as Module).default;
} catch {
  // As above.
}
let exported: unknown;
try {
  exported = (require('react-native/Libraries/Animated/Animated') as Module).default;
} catch {
  // As above.
}
let valueClass: unknown;
try {
  valueClass = (require('react-native/Libraries/Animated/nodes/AnimatedValue') as Module).default;
} catch {
  // As above.
}

followDrivers({ eventClass, implementation, exported, valueClass });
// Stryker restore all
