import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import { Alert } from 'react-native';
import { PlaygroundNative } from '../modules/playground-native';
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
  expect(alert.mock.calls[0][1]).toBe(
    'The app will crash. Turn on Setup → Auto-launch first (or tap Home → Launch after reopening) to send the report.',
  );
  const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === 'Crash')?.onPress?.(); });
  expect(Bugsee.testJsCrash).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(Bugsee.testJsCrash).toHaveBeenCalled();
  alert.mockRestore();
  jest.useRealTimers();
});
test.each(errorsActions.filter((a) => a.call.startsWith('PlaygroundNative.crash')).map((a) => [a.id, a] as const))(
  '%s throws "native module unavailable" in the tap, without scheduling, when the module is missing',
  (_id, action) => {
    jest.useFakeTimers();
    const native = PlaygroundNative as unknown as { available: boolean };
    native.available = false;
    try {
      expect(() => action.run()).toThrow('native module unavailable');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      native.available = true;
      jest.useRealTimers();
    }
  },
);

test('native signal crashes: crash(segv|abort) on iOS only, the NDK pair on Android only', () => {
  const by = (id: string) => errorsActions.find((a) => a.id === id)!;
  for (const k of ['segv', 'abort']) {
    expect(by(`crash-native-${k}`).platforms).toEqual(['ios']);
    expect(by(`crash-ndk-${k}`).platforms).toEqual(['android']);
  }
  for (const k of ['exception', 'backgroundThread']) expect(by(`crash-native-${k}`).platforms).toBeUndefined();
});
