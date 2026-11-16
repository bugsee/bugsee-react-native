import {
  LEGACY_OPTION_KEYS,
  describeUnknownKey,
  resetUnknownOptionWarnings,
  unknownOptionKeys,
  warnUnknownOptions,
} from '../unknownKeys';
import { keysFor } from '../keys';

beforeEach(resetUnknownOptionWarnings);

describe('unknownOptionKeys', () => {
  it('accepts every key the platform declares', () => {
    for (const platform of ['ios', 'android'] as const) {
      const all = Object.fromEntries([...keysFor(platform)].map((key) => [key, true]));
      expect(unknownOptionKeys(platform, all)).toEqual([]);
    }
  });

  it('accepts the shake key on both platforms, the option behind the original report', () => {
    const options = { 'com.bugsee.option.reporting.triggers.shake': false };
    expect(unknownOptionKeys('android', options)).toEqual([]);
    expect(unknownOptionKeys('ios', options)).toEqual([]);
  });

  it('rejects a key only the other platform declares', () => {
    expect(
      unknownOptionKeys('android', { 'com.bugsee.option.capture.avplayer': true }),
    ).toEqual(['com.bugsee.option.capture.avplayer']);
    expect(
      unknownOptionKeys('ios', { 'com.bugsee.option.detect.exit.low_memory': true }),
    ).toEqual(['com.bugsee.option.detect.exit.low_memory']);
  });

  it('rejects an unknown key without looking at its value', () => {
    expect(unknownOptionKeys('android', { nope: undefined })).toEqual(['nope']);
  });
});

describe('describeUnknownKey', () => {
  it('names the 7.x key for a 6.x name and says Android ignores it', () => {
    const message = describeUnknownKey('android', 'ShakeToReport');
    expect(message).toContain('"ShakeToReport"');
    expect(message).toContain('com.bugsee.option.reporting.triggers.shake');
    expect(message).toMatch(/Android SDK ignores it/);
  });

  it('says a 6.x name still works on iOS but not Android', () => {
    expect(describeUnknownKey('ios', 'ShakeToReport')).toMatch(/Android SDK ignores it/);
  });

  it('suggests the nearest key for a typo', () => {
    expect(
      describeUnknownKey('android', 'com.bugsee.option.reporting.triggers.shak'),
    ).toContain('Did you mean "com.bugsee.option.reporting.triggers.shake"?');
  });

  it('treats Object.prototype member names as ordinary unknown keys, not 6.x names', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const message = describeUnknownKey('android', key);
      expect(message).toContain('is not a launch option');
      expect(message).not.toContain('6.x');
      expect(message).not.toContain('native code');
    }
  });

  it('offers no suggestion when nothing is close', () => {
    expect(describeUnknownKey('ios', 'zzzzzzzzzzzzzzzz')).not.toContain('Did you mean');
  });

  it('only maps 6.x names to keys that exist', () => {
    for (const [legacy, key] of Object.entries(LEGACY_OPTION_KEYS)) {
      const known = keysFor('ios').has(key) || keysFor('android').has(key);
      expect({ legacy, known }).toEqual({ legacy, known: true });
    }
  });
});

describe('warnUnknownOptions', () => {
  it('warns once per unknown key and stays quiet for known ones', () => {
    const warn = jest.fn();
    const options = {
      'com.bugsee.option.capture.logs': true,
      ShakeToReport: false,
      nope: 1,
    };
    warnUnknownOptions('android', options, warn);
    warnUnknownOptions('android', options, warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => m).join('\n')).toMatch(/ShakeToReport[\s\S]*nope/);
  });

  it('warns per platform, since each SDK knows different keys', () => {
    const warn = jest.fn();
    const options = { 'com.bugsee.option.capture.avplayer': true };
    warnUnknownOptions('ios', options, warn);
    warnUnknownOptions('android', options, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for an empty map', () => {
    const warn = jest.fn();
    warnUnknownOptions('ios', {}, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
