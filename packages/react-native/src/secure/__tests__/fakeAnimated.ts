/**
 * Stand-ins for the React Native `Animated` internals `followEvents.ts`
 * follows: the `AnimatedEvent` class, `AnimatedImplementation` and the public
 * `Animated` object (each with `attachNativeEvent`), and the `AnimatedValue`
 * class. A test file mocks the four module paths with these, so the package
 * follows them as it would React Native's own:
 *
 *   jest.mock('react-native/Libraries/Animated/AnimatedEvent', () => require('./fakeAnimated').eventModule);
 *
 * and so on for `implementationModule`, `animatedModule` and `valueModule`.
 */

/** React Native's `AnimatedEvent`, as far as attaching goes. */
export class FakeAnimatedEvent {
  constructor(readonly _argMapping: unknown[]) {}
  // Called with the view and the event's name, as React Native's are.
  __attach(...args: unknown[]): string {
    return args.length >= 0 ? 'attached' : '';
  }
  __detach(...args: unknown[]): string {
    return args.length >= 0 ? 'detached' : '';
  }
}

/** React Native's `attachNativeEventImpl`: a handle that detaches. */
export function fakeAttachNativeEvent(): { detach: () => string } {
  return { detach: () => 'detached' };
}

/** `AnimatedImplementation` (what ScrollView calls), and the public `Animated` it is spread into. */
export const implementation = {
  // Called with the view, the event's name and the mapping, as React Native's is.
  attachNativeEvent: fakeAttachNativeEvent as (...args: unknown[]) => { detach: () => string },
  timing: (): void => undefined,
};
export const animated = { ...implementation };

/** React Native's `AnimatedValue`: made native by an animation or an event with the native driver. */
export class FakeAnimatedValue {
  __isNative = false;
  __makeNative(): void {
    this.__isNative = true;
  }
}

export const eventModule = { AnimatedEvent: FakeAnimatedEvent };
export const implementationModule = { __esModule: true, default: implementation };
export const animatedModule = { __esModule: true, default: animated };
export const valueModule = { __esModule: true, default: FakeAnimatedValue };

/**
 * Makes `node` an `Animated.Value` made native as an app's would be (by its
 * first animation or event with the native driver), after the package
 * loaded: what drives it is known.
 */
export function madeNative<T extends object>(node: T): T {
  Object.setPrototypeOf(node, FakeAnimatedValue.prototype);
  (node as unknown as { __isNative: boolean }).__isNative = false;
  (node as unknown as FakeAnimatedValue).__makeNative();
  return node;
}
