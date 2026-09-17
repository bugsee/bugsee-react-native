import { parseAndroidKeys, parseIosKeys, splitByPlatform } from '../option-keys';

describe('parseIosKeys', () => {
  // Shape taken from BugseeOptions.m. The header only declares the symbols;
  // the string values live in the .m, so that is what must be read.
  const SOURCE = `
NSString *const BugseeOptionCaptureLogs = @"com.bugsee.option.capture.logs";
NSString *const BugseeOptionDetectAndReportCrash = @"com.bugsee.option.detect.crash";
NSString *const BugseeSomethingElse = @"not.an.option";
`;

  it('reads the option keys and ignores unrelated constants', () => {
    expect(parseIosKeys(SOURCE)).toEqual([
      'com.bugsee.option.capture.logs',
      'com.bugsee.option.detect.crash',
    ]);
  });

  it('returns them sorted and unique', () => {
    const doubled = SOURCE + SOURCE;
    expect(parseIosKeys(doubled)).toEqual([
      'com.bugsee.option.capture.logs',
      'com.bugsee.option.detect.crash',
    ]);
  });
});

describe('parseAndroidKeys', () => {
  // Android assembles its keys from constants in the Options interface.
  // Grepping OptionsDescriptors.java for literals finds only three special
  // keys and would report the shared set as nearly empty.
  const SOURCE = `
public interface Options {
    String CaptureLogs = "com.bugsee.option.capture.logs";
    String VideoMode = "com.bugsee.option.capture.video.mode";
    String Endpoint = "com.bugsee.option.$$ENDPOINT";
}`;

  it('reads the constants', () => {
    expect(parseAndroidKeys(SOURCE)).toEqual([
      'com.bugsee.option.$$ENDPOINT',
      'com.bugsee.option.capture.logs',
      'com.bugsee.option.capture.video.mode',
    ]);
  });
});

describe('splitByPlatform', () => {
  const ios = ['a', 'b', 'ios-only'];
  const android = ['a', 'b', 'android-only'];

  it('separates shared from platform-specific', () => {
    expect(splitByPlatform(ios, android)).toEqual({
      shared: ['a', 'b'],
      ios: ['ios-only'],
      android: ['android-only'],
    });
  });

  it('puts every key in exactly one bucket', () => {
    const { shared, ios: i, android: a } = splitByPlatform(ios, android);
    const all = [...shared, ...i, ...a];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...new Set([...ios, ...android])].sort());
  });

  it('refuses to guess when a side is empty', () => {
    expect(() => splitByPlatform([], android)).toThrow(/empty/i);
    expect(() => splitByPlatform(ios, [])).toThrow(/empty/i);
  });
});
