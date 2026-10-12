import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildLaunchOptions } from '../src/session/launch';
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
test.each([
  ['advanced null', { advanced: null }],
  ['common string', { common: 'abc' }],
  ['common array', { common: [1] }],
  ['endpoint number', { endpoint: 5 }],
  ['autoLaunch string', { autoLaunch: 'yes' }],
  ['common.video string', { common: { video: 'no' } }],
])('normalises malformed %s without crashing', async (_n, extra) => {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify({ version: 1, token: 't', ...extra }));
  const c = await loadConfig();
  expect(c).toEqual({ ...DEFAULT_CONFIG, token: 't' });
  expect(() => buildLaunchOptions(c, 'ios')).not.toThrow();
  expect(() => buildLaunchOptions(c, 'android')).not.toThrow();
});
test('keeps valid nested values, drops invalid ones, returns fresh copies', async () => {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify({
    version: 1, token: 't', advanced: { a: '1', b: 2 }, common: { video: false, duration: 30, maxDataSize: 'x', hang: 1 },
  }));
  const c = await loadConfig();
  expect(c.advanced).toEqual({ a: '1' });
  expect(c.common).toEqual({ ...DEFAULT_CONFIG.common, video: false, duration: 30 });
  const d = await loadConfig();
  expect(d.common).not.toBe(DEFAULT_CONFIG.common);
  await AsyncStorage.clear();
  const e = await loadConfig();
  expect(e).toEqual(DEFAULT_CONFIG);
  expect(e).not.toBe(DEFAULT_CONFIG);
  expect(e.common).not.toBe(DEFAULT_CONFIG.common);
});
