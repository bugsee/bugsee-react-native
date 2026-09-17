import { ANDROID_ENDPOINT_KEY, IOS_ENDPOINT_KEY, endpointFor } from '../endpoint';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { BugseeLaunchOptions } from '../BugseeLaunchOptions';

// The same logical endpoint has to be written two ways. iOS reads a plain
// `endpoint` key and uses it VERBATIM as the API base -- its own default is
// "https://api.bugsee.com/v2" -- so a supplied value must carry /v2. Android
// reads com.bugsee.option.$$ENDPOINT and normalises either form in apiUrl(),
// its own base being version-exclusive.
describe('endpointFor(ios)', () => {
  it('appends /v2 when absent', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  it('leaves an endpoint that already carries /v2 alone', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com/v2'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  // Appending to a trailing slash would produce "//v2".
  it('does not double the separator', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com/'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  it('strips a run of trailing slashes, not just one', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com///'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  it('normalises a trailing slash after /v2', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com/v2/'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  // "/v20" ends with neither; matching on a bare "v2" substring would.
  it('does not mistake a longer path segment for the version', () => {
    expect(endpointFor('ios', 'https://apidev.bugsee.com/v20'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v20/v2' });
  });

  it('keeps a path that merely contains v2 earlier', () => {
    expect(endpointFor('ios', 'https://v2.example.com/api'))
      .toEqual({ [IOS_ENDPOINT_KEY]: 'https://v2.example.com/api/v2' });
  });
});

describe('endpointFor(android)', () => {
  it('passes the endpoint through untouched', () => {
    expect(endpointFor('android', 'https://apidev.bugsee.com'))
      .toEqual({ [ANDROID_ENDPOINT_KEY]: 'https://apidev.bugsee.com' });
  });

  // apiUrl() normalises either form, so a caller who supplied /v2 for iOS is
  // not punished for it here.
  it('accepts one that already carries /v2', () => {
    expect(endpointFor('android', 'https://apidev.bugsee.com/v2'))
      .toEqual({ [ANDROID_ENDPOINT_KEY]: 'https://apidev.bugsee.com/v2' });
  });

  it('uses a different key from iOS', () => {
    expect(ANDROID_ENDPOINT_KEY).not.toBe(IOS_ENDPOINT_KEY);
    expect(ANDROID_ENDPOINT_KEY).toBe('com.bugsee.option.$$ENDPOINT');
    expect(IOS_ENDPOINT_KEY).toBe('endpoint');
  });
});

describe('an unrecognised platform', () => {
  it('is refused rather than treated as iOS', () => {
    expect(() => endpointFor('web' as 'ios', 'https://x.test'))
      .toThrow(/ios.*android|android.*ios/);
    expect(() => endpointFor('' as 'ios', 'https://x.test')).toThrow();
  });
});

describe('an empty endpoint', () => {
  // Setting it to "" would override the SDK's own default with nothing.
  it.each(['ios', 'android'] as const)('is dropped on %s', (platform) => {
    expect(endpointFor(platform, '')).toEqual({});
    expect(endpointFor(platform, '   ')).toEqual({});
    expect(endpointFor(platform, undefined)).toEqual({});
  });
});

describe('a value that is not a string', () => {
  // The platform guard found this by probing every accessor with true and 1:
  // `endpoint?.trim()` threw rather than reading as "nothing supplied".
  it.each([true, 1, {}, [], null] as unknown[])(
    'reads %p as no endpoint rather than throwing',
    (value) => {
      expect(endpointFor('ios', value as string)).toEqual({});
      expect(endpointFor('android', value as string)).toEqual({});
    },
  );
});

describe('the endpoint accessor on each options class', () => {
  it('writes the iOS key, normalised', () => {
    const options = new IOSLaunchOptions();
    options.endpoint = 'https://apidev.bugsee.com';
    expect(BugseeLaunchOptions.serialize(options))
      .toEqual({ endpoint: 'https://apidev.bugsee.com/v2' });
  });

  it('writes the Android key, verbatim', () => {
    const options = new AndroidLaunchOptions();
    options.endpoint = 'https://apidev.bugsee.com';
    expect(BugseeLaunchOptions.serialize(options))
      .toEqual({ 'com.bugsee.option.$$ENDPOINT': 'https://apidev.bugsee.com' });
  });

  it('reads back what the SDK will receive, not what was typed', () => {
    const options = new IOSLaunchOptions();
    options.endpoint = 'https://apidev.bugsee.com';
    expect(options.endpoint).toBe('https://apidev.bugsee.com/v2');
  });

  it('clears on undefined', () => {
    const options = new AndroidLaunchOptions();
    options.endpoint = 'https://apidev.bugsee.com';
    options.endpoint = undefined;
    expect(BugseeLaunchOptions.serialize(options)).toEqual({});
  });
});
