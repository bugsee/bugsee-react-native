/**
 * On iOS a react-native-screens modal presentation slides its screen up
 * over the one below by default.
 */
import { stackMotionOf } from '../transition';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

it('a modal presentation with the default animation slides up on iOS; a push does not', () => {
  expect(stackMotionOf({ stackPresentation: 'formSheet' })).toBe('upwards');
  expect(stackMotionOf({ stackAnimation: 'default', stackPresentation: 'modal' })).toBe('upwards');
  expect(stackMotionOf({ stackPresentation: 'push' })).toBe('any');
  // An animation of the app's own is not the default slide.
  expect(stackMotionOf({ stackAnimation: 'custom', stackPresentation: 'modal' })).toBe('any');
});

const PRESENTATIONS = [
  'modal',
  'fullScreenModal',
  'formSheet',
  'pageSheet',
  'transparentModal',
  'containedModal',
  'containedTransparentModal',
];

it.each(PRESENTATIONS)('%s slides up on iOS, and scales the screen below: any motion there', (stackPresentation) => {
  expect(stackMotionOf({ stackPresentation })).toBe('upwards');
  expect(stackMotionOf({ stackPresentation }, false)).toBe('any');
});

it('an explicit slide from the bottom leaves the screen below where it is', () => {
  expect(stackMotionOf({ stackAnimation: 'slide_from_bottom', stackPresentation: 'formSheet' }, false)).toBe(
    'upwards',
  );
});
