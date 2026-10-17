import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';
import { ActionButton, describe, describeError } from '../src/ui/ActionButton';
import { Screen } from '../src/ui/Screen';
const inLog = () => within(screen.getByTestId('result-log'));
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
  ['void call', () => undefined, '→ done (returns nothing)'],
  ['void promise', () => Promise.resolve(), '→ done (returns nothing)'],
  ['sync throw', () => { throw Object.assign(new TypeError('bad'), { code: 'E_X' }); }, '✗ TypeError [E_X]: bad'],
  ['rejection', () => Promise.reject(new Error('nope')), '✗ Error: nope'],
])('logs a %s', async (_n, run, line) => {
  await render(<Screen title="T"><ActionButton action={{ ...base, run }} /></Screen>);
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(inLog().getByText(line, { exact: false })).toBeTruthy());
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
test('logs a rejection from a non-Promise thenable', async () => {
  const run = () => ({ then: (_res: unknown, rej: (e: unknown) => void) => rej(new Error('x')) });
  await render(<Screen title="T"><ActionButton action={{ ...base, run }} /></Screen>);
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(inLog().getByText('✗ Error: x', { exact: false })).toBeTruthy());
});
test('a resolved Error is logged through describeError', async () => {
  await render(<Screen title="T"><ActionButton action={{ ...base, run: () => Promise.resolve(new RangeError('r')) }} /></Screen>);
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(inLog().getByText('→ RangeError: r', { exact: false })).toBeTruthy());
});
test('describe and describeError never throw', () => {
  const circ: Record<string, unknown> = Object.create(null);
  circ.self = circ;
  const bad = { toString() { throw new Error('no'); }, toJSON() { throw new Error('no'); } };
  expect(describe(circ)).toBe('[unprintable]');
  expect(describe(bad)).toBe('[unprintable]');
  expect(describeError(circ)).toBe('[unprintable]');
});
test('echoes the latest outcome on the card itself', async () => {
  let fail = false;
  const run = () => (fail ? Promise.reject(new Error('nope')) : Promise.resolve(true));
  await render(<Screen title="T"><ActionButton action={{ ...base, run }} /></Screen>);
  expect(screen.queryByTestId('action-result-a')).toBeNull();
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(screen.getByTestId('action-result-a')).toHaveTextContent('→ true'));
  fail = true;
  await fireEvent.press(screen.getByText('Do it'));
  await waitFor(() => expect(screen.getByTestId('action-result-a')).toHaveTextContent('✗ Error: nope'));
});
