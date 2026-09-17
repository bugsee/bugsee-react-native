import { WRAPPER_TYPE, wrapperIdentity } from '../identity';

describe('wrapper type', () => {
  /**
   * `react_native`, matching the backend's own identifier for this wrapper
   * (`APPLICATION_SUB_TYPE_REACT_NATIVE` in appserver). Three spellings exist
   * in the wild and they are not interchangeable:
   *
   *   react_native   appserver's application subtype, and the plan
   *   react-native   the Android SDK's doc comment, illustrative prose
   *   react          what the 6.x wrapper actually sent as wrapper_info.type
   *
   * Symbolication does NOT route on this — the worker keys on the exception
   * type (`rct` / `react`) — so this is identification, not dispatch.
   */
  it('is the backend spelling', () => {
    expect(WRAPPER_TYPE).toBe('react_native');
  });
});

describe('wrapperIdentity', () => {
  const base = {
    version: '1.2.3',
    reactNativeVersion: '0.87.1',
    hermes: true,
    dev: true,
  };

  it('reports the package version', () => {
    expect(wrapperIdentity(base).version).toBe('1.2.3');
  });

  it('carries the type', () => {
    expect(wrapperIdentity(base).type).toBe('react_native');
  });

  it('describes the runtime in context', () => {
    expect(wrapperIdentity(base).context).toEqual({
      'react-native': '0.87.1',
      'js-engine': 'hermes',
      'build-configuration': 'debug',
    });
  });

  it('names JavaScriptCore when Hermes is absent', () => {
    expect(wrapperIdentity({ ...base, hermes: false }).context['js-engine'])
      .toBe('jsc');
  });

  it('reports a release build', () => {
    expect(wrapperIdentity({ ...base, dev: false }).context['build-configuration'])
      .toBe('release');
  });

  // The SDKs type context as a string map on both platforms, so a non-string
  // would either be dropped or crash the bridge depending on the platform.
  it('gives every context value as a string', () => {
    for (const value of Object.values(wrapperIdentity(base).context)) {
      expect(typeof value).toBe('string');
    }
  });

  // An unknown version is better reported as unknown than as a lie: an empty
  // string reads as "the wrapper has no version" in the report's environment.
  it('falls back to unknown rather than empty', () => {
    expect(wrapperIdentity({ ...base, version: '' }).version).toBe('unknown');
    expect(wrapperIdentity({ ...base, reactNativeVersion: '' })
      .context['react-native']).toBe('unknown');
  });

  it('has no build by default, which the SDKs allow', () => {
    expect(wrapperIdentity(base).build).toBeUndefined();
  });

  it('carries a build when one is supplied', () => {
    expect(wrapperIdentity({ ...base, build: '42' }).build).toBe('42');
  });
});
