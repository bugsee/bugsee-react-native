import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Bugsee from '@bugsee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_CONFIG, saveConfig } from '../src/session/config';
import { SessionProvider } from '../src/session/SessionProvider';
import { useSession } from '../src/session/SessionContext';

const VALID = '3f2a9c1e-5b7d-4e68-8a10-2c9d4b6e7f01';
const B = Bugsee as unknown as Record<string, jest.Mock>;
function Probe() {
  const s = useSession();
  return <Text testID="p">{`${s.ready}|${s.status}|${s.lifecycle.length}`}</Text>;
}
const probe = () => screen.getByTestId('p').props.children as string;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

test('auto-launches with a valid token before ready, subscribes, records events and polls status', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, autoLaunch: true, token: VALID, everLaunched: true });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  expect(B.launch).toHaveBeenCalledTimes(1);
  expect(B.launch.mock.calls[0][0]).toBe(VALID);
  expect(B.onLifecycleEvent).toHaveBeenCalledTimes(1);
  expect(B.getStatus).toHaveBeenCalledTimes(1);
  expect(probe()).toBe('true|2|0');
  await act(async () => { B.onLifecycleEvent.mock.calls[0][0]('BeforeReportShown'); });
  expect(probe()).toBe('true|2|1');
});

test('does not launch when autoLaunch is off', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, autoLaunch: false, token: VALID, everLaunched: true });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  expect(B.launch).not.toHaveBeenCalled();
});

test('does not launch with an invalid token but still becomes ready', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, autoLaunch: true, token: 'nope', everLaunched: true });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  expect(B.launch).not.toHaveBeenCalled();
});

test('records a failed auto-launch in the lifecycle log', async () => {
  B.launch.mockRejectedValueOnce(new Error('boom'));
  await saveConfig({ ...DEFAULT_CONFIG, autoLaunch: true, token: VALID, everLaunched: true });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe()).toBe('true|2|1'));
});

test('keeps at most 100 lifecycle entries', async () => {
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  await act(async () => { for (let i = 0; i < 130; i++) B.onLifecycleEvent.mock.calls[0][0](`E${i}`); });
  expect(probe()).toBe('true|2|100');
});
