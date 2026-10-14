/**
 * R3-2: the package entry starts following native `Animated` events as it
 * is imported, not when the app first reads `BugseeSecure` (Metro's
 * `inlineRequires` evaluates a re-export only then).
 */
import type * as NativeAnimation from '../nativeAnimation';
import { FakeAnimatedEvent, madeNative } from './fakeAnimated';

jest.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android', constants: { reactNativeVersion: { major: 0, minor: 87, patch: 1 } } },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);
jest.mock('react-native/Libraries/Animated/AnimatedEvent', () => require('./fakeAnimated').eventModule);
jest.mock(
  'react-native/Libraries/Animated/AnimatedImplementation',
  () => require('./fakeAnimated').implementationModule,
);
jest.mock('react-native/Libraries/Animated/Animated', () => require('./fakeAnimated').animatedModule);
jest.mock('react-native/Libraries/Animated/nodes/AnimatedValue', () => require('./fakeAnimated').valueModule);
// As inlineRequires leaves it: not evaluated until the app reads it.
jest.mock('../BugseeSecure', () => ({ BugseeSecure: (): null => null }));

it('R3-2: an event attached before the first BugseeSecure is read is counted', () => {
  // The app imports the package (to launch Bugsee), then mounts a screen whose list attaches its scroll.
  require('../../index');
  const scrollY = madeNative({ _value: 0, _offset: 0, _animation: null, __getValue: () => 0 });
  expect(new FakeAnimatedEvent([{ nativeEvent: { contentOffset: { y: scrollY } } }]).__attach(9, 'onScroll')).toBe(
    'attached',
  );

  // Only now does the first <BugseeSecure> load what bounds native transforms.
  const { nodeBound } = require('../nativeAnimation') as typeof NativeAnimation;

  expect(nodeBound(scrollY).range).toBeUndefined();
});
