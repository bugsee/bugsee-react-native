// `react-native` is not resolvable in this unit environment, and the factory
// reads Platform.OS for its default. Mocked to a known value so the explicit
// argument and the default are both exercised.
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { BugseeLaunchOptions } from '../BugseeLaunchOptions';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { createDefaultLaunchOptions } from '../createDefaultLaunchOptions';
import { keysFor } from '../keys';

/** Every accessor a class declares, walking its prototype chain. */
function accessorsOf(instance: object): string[] {
  const found: string[] = [];
  for (
    let proto = Object.getPrototypeOf(instance);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const [name, d] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (d.set !== undefined && !found.includes(name)) {
        found.push(name);
      }
    }
  }
  return found;
}

/** A value each accessor will accept, chosen by nothing more than type. */
const PROBES: unknown[] = [true, 1, 'x'];

describe.each([
  ['ios', () => new IOSLaunchOptions()],
  ['android', () => new AndroidLaunchOptions()],
] as const)('%s options', (platform, make) => {
  const allowed = keysFor(platform);

  // The point of Task 2.2: an iOS-only key must not be reachable from an
  // Android options object through a first-class accessor, and vice versa.
  // setCustomOption is deliberately exempt -- it exists to reach keys the
  // wrapper has not surfaced, including ones added in a future 7.x patch.
  it('writes only keys its own platform accepts', () => {
    const instance = make();
    const names = accessorsOf(instance);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      for (const probe of PROBES) {
        try {
          (instance as unknown as Record<string, unknown>)[name] = probe;
        } catch {
          continue; // a setter that rejects this probe's type
        }
      }
    }

    for (const key of Object.keys(BugseeLaunchOptions.serialize(instance))) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('reaches at least one key of its own platform, not just shared ones', () => {
    const instance = make();
    for (const name of accessorsOf(instance)) {
      (instance as unknown as Record<string, unknown>)[name] = true;
    }
    const written = Object.keys(BugseeLaunchOptions.serialize(instance));
    const ownOnly = [...allowed].filter(
      (k) => !keysFor(platform === 'ios' ? 'android' : 'ios').has(k),
    );
    expect(written.some((k) => ownOnly.includes(k))).toBe(true);
  });
});

describe('createDefaultLaunchOptions', () => {
  it('builds the class matching the running platform', () => {
    expect(createDefaultLaunchOptions('ios')).toBeInstanceOf(IOSLaunchOptions);
    expect(createDefaultLaunchOptions('android')).toBeInstanceOf(
      AndroidLaunchOptions,
    );
  });

  it('starts empty, so the SDK applies its own defaults', () => {
    // The wrapper pre-populating defaults is how the 6.x implementation
    // drifted: it shipped videoMode = V3, a value 7.x removed, and set
    // iOS-only frame-rate keys on Android.
    expect(BugseeLaunchOptions.serialize(createDefaultLaunchOptions('ios')))
      .toEqual({});
  });

  it('defaults to the running platform', () => {
    expect(createDefaultLaunchOptions()).toBeInstanceOf(AndroidLaunchOptions);
  });

  it('refuses a platform neither SDK serves', () => {
    expect(() =>
      createDefaultLaunchOptions('windows' as unknown as 'ios'),
    ).toThrow(/windows/);
  });
});
