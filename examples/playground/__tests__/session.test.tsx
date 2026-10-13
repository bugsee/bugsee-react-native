import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Bugsee from '@bugsee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_CONFIG, loadConfig, patchConfig, saveConfig } from '../src/session/config';
import { REPORT_HANDLER_PRESETS } from '../src/reportHandlers';
import { localClock, SessionProvider } from '../src/session/SessionProvider';
import { useSession } from '../src/session/SessionContext';

const VALID = '00000000-0000-4000-8000-000000000001';
const B = Bugsee as unknown as Record<string, jest.Mock>;
let latest: ReturnType<typeof useSession>;
function Probe() {
  const s = useSession();
  latest = s;
  return <Text testID="p">{`${s.ready}|${s.status}|${s.lifecycle.length}`}</Text>;
}
const events = () => latest.lifecycle.map((l) => l.event);
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
  await act(async () => { B.onLifecycleEvent.mock.calls[0][0]({ name: 'BeforeReportShown' }); });
  expect(probe()).toBe('true|2|1');
  expect(events()).toEqual(['BeforeReportShown']);
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
  await act(async () => { for (let i = 0; i < 130; i++) B.onLifecycleEvent.mock.calls[0][0]({ name: `E${i}` }); });
  expect(probe()).toBe('true|2|100');
});

test('logs the event name, with the report id when the event carries one', async () => {
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  await act(async () => {
    B.onLifecycleEvent.mock.calls[0][0]({ name: 'AfterReportShown' });
    B.onLifecycleEvent.mock.calls[0][0]({ name: 'AfterReportUploaded', reportId: 'r-1' });
  });
  expect(events()).toEqual(['AfterReportShown', 'AfterReportUploaded (r-1)']);
  expect(events().join()).not.toContain('[object Object]');
});

test('note() adds a playground line to the lifecycle log', async () => {
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  await act(async () => { latest.note('Relaunched with the new options'); });
  expect(events()).toEqual(['Relaunched with the new options']);
});

test('everLaunched is persisted only after a successful launch', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, token: VALID });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  B.launch.mockRejectedValueOnce(new Error('boom'));
  await act(async () => { await expect(latest.launch()).rejects.toThrow('boom'); });
  expect((await loadConfig()).everLaunched).toBe(false);
  B.launch.mockResolvedValueOnce(false);
  await act(async () => { expect(await latest.launch()).toBe(false); });
  expect((await loadConfig()).everLaunched).toBe(false);
  await act(async () => { expect(await latest.launch()).toBe(true); });
  expect((await loadConfig()).everLaunched).toBe(true);
  expect(latest.config.everLaunched).toBe(true);
});

test('auto-launch installs the saved report handler before launch', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, autoLaunch: true, token: VALID, everLaunched: true, reportHandler: 'labels' });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  expect(B.setReportHandler).toHaveBeenCalledWith(REPORT_HANDLER_PRESETS.labels);
  expect(B.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(B.launch.mock.invocationCallOrder[0]);
});

test('Home launch and relaunch install the saved handler first; patchConfig goes through the provider', async () => {
  await saveConfig({ ...DEFAULT_CONFIG, token: VALID });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  await act(async () => { await patchConfig({ reportHandler: 'drop' }); });
  expect(latest.config.reportHandler).toBe('drop');
  expect((await loadConfig()).reportHandler).toBe('drop');
  await act(async () => { await latest.launch(); });
  expect(B.setReportHandler).toHaveBeenLastCalledWith(REPORT_HANDLER_PRESETS.drop);
  expect(B.setReportHandler.mock.invocationCallOrder.at(-1)!).toBeLessThan(B.launch.mock.invocationCallOrder[0]);
  B.setReportHandler.mockClear();
  await act(async () => { await latest.relaunch(); });
  expect(B.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(B.relaunch.mock.invocationCallOrder[0]);
});

test('localClock is local HH:MM:SS.mmm, not UTC', () => {
  expect(localClock(new Date(2026, 9, 12, 7, 5, 3, 9))).toBe('07:05:03.009');
  expect(localClock(new Date(2026, 9, 12, 23, 59, 59, 999))).toBe('23:59:59.999');
});

test('lifecycle lines carry the local time', async () => {
  await saveConfig({ ...DEFAULT_CONFIG });
  await render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(probe().startsWith('true')).toBe(true));
  jest.useFakeTimers({ now: new Date(2026, 9, 12, 7, 5, 3, 9) });
  try {
    await act(async () => { latest.note('hello'); });
  } finally {
    jest.useRealTimers();
  }
  expect(latest.lifecycle.at(-1)).toEqual({ at: '07:05:03.009', event: 'hello' });
});
