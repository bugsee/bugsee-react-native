import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { ActionButton } from '../src/ui/ActionButton';
import { Screen } from '../src/ui/Screen';
const base = { id: 'a', label: 'Do it', call: 'Bugsee.log("x")', expect: 'A line in the log' };
test('shows label, call and Expect', async () => {
  await render(<Screen title="T"><ActionButton action={{ ...base, run: () => 1 }} /></Screen>);
  expect(screen.getByText('Do it')).toBeTruthy();
  expect(screen.getByText('Bugsee.log("x")')).toBeTruthy();
  expect(screen.getByText('Expect: A line in the log')).toBeTruthy();
});
test.each([
  ['returned value', () => 42, '→ 42'],
  ['resolved value', () => Promise.resolve({ a: 1 }), '→ {"a":1}'],
  ['sync throw', () => { throw Object.assign(new TypeError('bad'), { code: 'E_X' }); }, '✗ TypeError [E_X]: bad'],
  ['rejection', () => Promise.reject(new Error('nope')), '✗ Error: nope'],
])('logs a %s', async (_n, run, line) => {
  await render(<Screen title="T"><ActionButton action={{ ...base, run }} /></Screen>);
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(screen.getByText(line, { exact: false })).toBeTruthy());
});
test('confirm asks first and runs only on OK', async () => {
  const run = jest.fn();
  const spy = jest.spyOn(Alert, 'alert');
  await render(<Screen title="T"><ActionButton action={{ ...base, run, confirm: 'Crash now?' }} /></Screen>);
  await fireEvent.press(screen.getByText('Do it'));
  expect(run).not.toHaveBeenCalled();
  const buttons = spy.mock.calls[0][2]!;
  await act(async () => { buttons.find((b) => b.text === 'Crash')!.onPress!(); });
  expect(run).toHaveBeenCalled();
});
test('hidden on other platforms', async () => {
  expect(Platform.OS).toBe('ios'); // jest-expo default platform
  await render(<Screen title="T"><ActionButton action={{ ...base, run: () => 0, platforms: ['android'] }} /></Screen>);
  expect(screen.queryByText('Do it')).toBeNull();
});
