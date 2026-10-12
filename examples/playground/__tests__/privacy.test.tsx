import { fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import PrivacyScreen, { privacyActions } from '../src/screens/PrivacyScreen';
import { callTarget } from '../src/ui/action';

test('every privacy action has a valid call target and unique id', () => {
  privacyActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(privacyActions.map((a) => a.id)).size).toBe(privacyActions.length);
  expect(privacyActions.filter((a) => a.call.startsWith('Bugsee.setSecureRectangles(')).length).toBe(2);
});
test('renders labels and pressing start blackout calls the mock', async () => {
  await render(<PrivacyScreen />);
  expect(screen.getByText('This box is redacted')).toBeTruthy();
  await fireEvent.press(screen.getByText('Start blackout'));
  expect(Bugsee.startBlackout).toHaveBeenCalled();
});
test('set and clear secure rectangle draws and removes the overlay', async () => {
  await render(<PrivacyScreen />);
  await fireEvent.press(screen.getByText('Set secure rectangle'));
  expect(Bugsee.setSecureRectangles).toHaveBeenCalledWith([{ x: 20, y: 200, width: 200, height: 80 }]);
  expect(screen.getAllByTestId('secure-overlay')).toHaveLength(1);
  await fireEvent.press(screen.getByText('Clear secure rectangles'));
  expect(screen.queryAllByTestId('secure-overlay')).toHaveLength(0);
});
