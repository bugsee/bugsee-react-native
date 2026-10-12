import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONFIG_KEY, DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/session/config';
beforeEach(() => AsyncStorage.clear());
test('round-trips', async () => {
  const c = { ...DEFAULT_CONFIG, token: 'x', autoLaunch: true };
  await saveConfig(c);
  expect(await loadConfig()).toEqual(c);
});
test.each([['not json'], ['{"version":0,"token":"x"}'], ['null'], ['[]'], ['{"version":1,"token":5}']])(
  'falls back to defaults for %j', async (stored) => {
    await AsyncStorage.setItem(CONFIG_KEY, stored);
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });
test('fills fields missing from an older v1 save', async () => {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify({ version: 1, token: 't' }));
  expect(await loadConfig()).toEqual({ ...DEFAULT_CONFIG, token: 't' });
});
