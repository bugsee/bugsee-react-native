import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import { Alert } from 'react-native';
import ErrorsScreen, { errorsActions } from '../src/screens/ErrorsScreen';
import { callTarget } from '../src/ui/action';

test('actions have valid call targets and unique ids', () => {
  errorsActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(errorsActions.map((a) => a.id)).size).toBe(errorsActions.length);
});
test('renders labels and the boundary demo', async () => {
  await render(<ErrorsScreen />);
  expect(screen.getByText('Log handled string')).toBeTruthy();
  expect(screen.getByText('Throw inside ErrorBoundary')).toBeTruthy();
  expect(screen.queryByText('Native crash: segv (NDK)')).toBeNull();
});
test('pressing a non-crash action calls its mock', async () => {
  await render(<ErrorsScreen />);
  await fireEvent.press(screen.getByText('Log handled string'));
  expect(Bugsee.logException).toHaveBeenCalledWith('a plain string');
});
test('a crash action confirms, then crashes after 300 ms', async () => {
  jest.useFakeTimers();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<ErrorsScreen />);
  await fireEvent.press(screen.getByText('JS crash'));
  expect(alert).toHaveBeenCalled();
  expect(alert.mock.calls[0][1]).toBe('The app will crash. Reopen it to send the report.');
  const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === 'Crash')?.onPress?.(); });
  expect(Bugsee.testJsCrash).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(Bugsee.testJsCrash).toHaveBeenCalled();
  alert.mockRestore();
  jest.useRealTimers();
});
