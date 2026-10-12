import AsyncStorage from '@react-native-async-storage/async-storage';
import Bugsee from '@bugsee/react-native';
import { DEFAULT_CONFIG, loadConfig, patchConfig } from '../src/session/config';
import { launchWith, relaunchWith } from '../src/session/launch';
import { REPORT_HANDLER_PRESETS } from '../src/reportHandlers';
import { reportsActions } from '../src/screens/ReportsScreen';

const b = Bugsee as unknown as Record<string, jest.Mock>;
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

test('launchWith installs the saved handler before Bugsee.launch', async () => {
  await launchWith({ ...DEFAULT_CONFIG, token: 't', reportHandler: 'labels' });
  expect(b.setReportHandler).toHaveBeenCalledWith(REPORT_HANDLER_PRESETS.labels);
  expect(b.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(b.launch.mock.invocationCallOrder[0]);
});
test('launchWith with no saved handler installs null before launch', async () => {
  await launchWith({ ...DEFAULT_CONFIG, token: 't' });
  expect(b.setReportHandler).toHaveBeenCalledWith(null);
  expect(b.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(b.launch.mock.invocationCallOrder[0]);
});
test('relaunchWith installs the saved handler before Bugsee.relaunch', async () => {
  await relaunchWith({ ...DEFAULT_CONFIG, reportHandler: 'drop' });
  expect(b.setReportHandler).toHaveBeenCalledWith(REPORT_HANDLER_PRESETS.drop);
  expect(b.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(b.relaunch.mock.invocationCallOrder[0]);
});
test('a handler chosen on Reports survives a restart and is installed by the next launch', async () => {
  await patchConfig({ token: 't' });
  await reportsActions.find((a) => a.id === 'handler-attach')!.run();
  expect(b.setReportHandler).toHaveBeenLastCalledWith(REPORT_HANDLER_PRESETS.attachFile);
  b.setReportHandler.mockClear();
  // "Restart": nothing in memory but storage.
  const loaded = await loadConfig();
  expect(loaded.reportHandler).toBe('attachFile');
  await launchWith(loaded);
  expect(b.setReportHandler).toHaveBeenCalledWith(REPORT_HANDLER_PRESETS.attachFile);
  expect(b.setReportHandler.mock.invocationCallOrder[0]).toBeLessThan(b.launch.mock.invocationCallOrder[0]);
});
test('Handler: clear saves none', async () => {
  await reportsActions.find((a) => a.id === 'handler-labels')!.run();
  await reportsActions.find((a) => a.id === 'handler-clear')!.run();
  expect((await loadConfig()).reportHandler).toBe('none');
  expect(b.setReportHandler).toHaveBeenLastCalledWith(null);
});
