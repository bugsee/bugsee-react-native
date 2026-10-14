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
});
