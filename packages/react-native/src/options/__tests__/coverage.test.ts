jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { BugseeLaunchOptions } from '../BugseeLaunchOptions';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { NO_ACCESSOR, keysFor } from '../keys';

/** Every settable accessor on the instance's prototype chain. */
function setters(instance: object): string[] {
  const names: string[] = [];
  for (
    let proto = Object.getPrototypeOf(instance);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (d.set !== undefined && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** The keys the instance's accessors can write, found by calling each one. */
function reachableKeys(make: () => BugseeLaunchOptions): Set<string> {
  const reached = new Set<string>();
  for (const name of setters(make())) {
    const options = make();
    try {
      (options as unknown as Record<string, unknown>)[name] = 'https://example.invalid';
    } catch {
      continue;
    }
    for (const key of Object.keys(BugseeLaunchOptions.serialize(options))) {
      reached.add(key);
    }
  }
  return reached;
}

/**
 * The guard that stops this drifting again: every option a pinned SDK
 * registers is reachable through a typed accessor, or is listed in
 * `NO_ACCESSOR` with the reason it is not. A key added to `option-keys.json`
 * (by regenerating it for a new SDK) fails here until someone decides.
 *
 * Before this existed 21 of 109 options had an accessor, and shake-to-report
 * was reachable only through `setCustomOption`.
 */
describe.each([
  ['android', () => new AndroidLaunchOptions()],
  ['ios', () => new IOSLaunchOptions()],
] as const)('%s: every known option has a typed accessor', (platform, make) => {
  it('leaves no key reachable only through setCustomOption', () => {
    const reachable = reachableKeys(make);
    const missing = [...keysFor(platform)].filter(
      (key) => !reachable.has(key) && !(key in NO_ACCESSOR),
    );
    expect(missing).toEqual([]);
  });

  it('keeps NO_ACCESSOR honest: nothing listed there also has an accessor', () => {
    const reachable = reachableKeys(make);
    const stale = Object.keys(NO_ACCESSOR).filter(
      (key) => keysFor(platform).has(key) && reachable.has(key),
    );
    // `endpoint` is the one deliberate overlap: it IS reachable, through its own accessor.
    expect(stale.filter((key) => !/endpoint/i.test(key))).toEqual([]);
  });
});
