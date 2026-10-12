import { PLACEHOLDER_TOKEN, resolveBugseeConfig } from '../config/bugseeConfig';

const IOS = '1a2b3c4d-0000-4000-8000-000000000001';
const AND = '9f8e7d6c-0000-4000-8000-000000000002';

describe('resolveBugseeConfig', () => {
  it('passes the all-zero placeholder to the plugin but shows no prefix hint for it', () => {
    const r = resolveBugseeConfig({ env: { BUGSEE_APP_TOKEN: PLACEHOLDER_TOKEN } });
    expect(r.pluginProps.appToken).toEqual({ ios: PLACEHOLDER_TOKEN, android: PLACEHOLDER_TOKEN });
    expect(r.extra.bugseeTokenPrefix).toEqual({});
    const mixed = resolveBugseeConfig({ file: { appToken: { ios: PLACEHOLDER_TOKEN, android: AND } }, env: {} });
    expect(mixed.extra.bugseeTokenPrefix).toEqual({ android: '9f8e7d6c' });
    const upper = resolveBugseeConfig({ file: { appToken: PLACEHOLDER_TOKEN.toUpperCase() }, env: {} });
    expect(upper.extra.bugseeTokenPrefix).toEqual({});
  });
  it('passes per-platform tokens and exposes only 8-char prefixes in extra', () => {
    const r = resolveBugseeConfig({ file: { appToken: { ios: IOS, android: AND } }, env: {} });
    expect(r.pluginProps.appToken).toEqual({ ios: IOS, android: AND });
    expect(r.extra.bugseeTokenPrefix).toEqual({ ios: '1a2b3c4d', android: '9f8e7d6c' });
    expect(JSON.stringify(r.extra)).not.toContain(IOS);
  });
  it('omits endpoint when the file has none', () => {
    const r = resolveBugseeConfig({ file: { appToken: IOS }, env: {} });
    expect('endpoint' in r.pluginProps).toBe(false);
    expect('bugseeEndpoint' in r.extra).toBe(false);
  });
  it('passes endpoint and symbolicateReactNativeFrameworks through', () => {
    const r = resolveBugseeConfig({
      file: { appToken: IOS, endpoint: 'https://bugsee.example.com', symbolicateReactNativeFrameworks: true },
      env: {},
    });
    expect(r.pluginProps.endpoint).toBe('https://bugsee.example.com');
    expect(r.pluginProps.symbolicateReactNativeFrameworks).toBe(true);
    expect(r.extra.bugseeEndpoint).toBe('https://bugsee.example.com');
  });
  it('falls back to BUGSEE_APP_TOKEN, then BUGSEE_TOKEN_IOS for iOS', () => {
    expect(resolveBugseeConfig({ env: { BUGSEE_APP_TOKEN: AND } }).pluginProps.appToken).toEqual({ ios: AND, android: AND });
    expect(resolveBugseeConfig({ env: { BUGSEE_TOKEN_IOS: IOS } }).pluginProps.appToken).toEqual({ ios: IOS });
  });
  it('ignores placeholder values copied from the example file', () => {
    const r = resolveBugseeConfig({ file: { appToken: { ios: '<iOS app token>', android: '<Android app token>' } }, env: {} });
    expect(r.pluginProps.appToken).toBeUndefined();
    expect(r.extra.bugseeTokenPrefix).toEqual({});
  });
  it('treats a non-object file as absent', () => {
    expect(resolveBugseeConfig({ file: 'garbage', env: {} }).pluginProps).toEqual({});
  });
});
