import { DEFAULT_CONFIG } from '../src/session/config';
import { buildLaunchOptions } from '../src/session/launch';
import { parseOptionValue, ADVANCED_KEYS } from '../src/options/advanced';
test('empty endpoint passes no endpoint key', () => {
  const o = buildLaunchOptions(DEFAULT_CONFIG, 'android');
  expect(Object.keys(o).some((k) => k.includes('ENDPOINT') || k === 'endpoint')).toBe(false);
});
test('endpoint maps per platform', () => {
  const c = { ...DEFAULT_CONFIG, endpoint: 'https://bugsee.example.com' };
  expect(buildLaunchOptions(c, 'ios').endpoint).toBe('https://bugsee.example.com/v2');
  expect(buildLaunchOptions(c, 'android')['com.bugsee.option.$$ENDPOINT']).toBe('https://bugsee.example.com');
});
test('common options map to SDK keys', () => {
  const c = { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common, video: false, maxDataSize: 50 } };
  const o = buildLaunchOptions(c, 'ios');
  expect(o['com.bugsee.option.capture.video']).toBe(false);
  expect(o['com.bugsee.option.config.max-data-size']).toBe(50);
});
test('advanced overrides are typed and win over common', () => {
  const c = { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common, video: false }, advanced: { 'com.bugsee.option.capture.video': 'true', 'com.bugsee.option.config.notify-flush-delay': '3' } };
  const o = buildLaunchOptions(c, 'ios');
  expect(o['com.bugsee.option.capture.video']).toBe(true);
  expect(o['com.bugsee.option.config.notify-flush-delay']).toBe(3);
});
test('parseOptionValue', () => {
  expect([parseOptionValue('true'), parseOptionValue('false'), parseOptionValue('1.5'), parseOptionValue(' x ')]).toEqual([true, false, 1.5, 'x']);
});
test('ADVANCED_KEYS has the shared keys and is sorted', () => {
  expect(ADVANCED_KEYS).toContain('com.bugsee.option.detect.frustration');
  expect([...ADVANCED_KEYS].sort()).toEqual(ADVANCED_KEYS);
});
