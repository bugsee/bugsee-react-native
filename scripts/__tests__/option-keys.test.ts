import {
  parseAndroidKeys,
  parseIosKeys,
  parseJavaEnum,
  splitByPlatform,
} from '../option-keys';

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

describe('parseJavaEnum', () => {
  it('reads the constructor value, not the declaration order', () => {
    expect(parseJavaEnum(`
public enum VideoMode {
    None(0),
    V1(1),
    V2(2),
    Fullscreen(20),
    DirectBuffers(21);
}`)).toEqual({ None: 0, V1: 1, V2: 2, Fullscreen: 20, DirectBuffers: 21 });
  });

  // A name class without digits drops V1 and V2, which makes Fullscreen look
  // like ordinal 1 instead of 3. That mistake was actually made.
  it('keeps constants whose names contain digits', () => {
    expect(Object.keys(parseJavaEnum('enum X {\n    V1(1),\n    V2(2);\n}')))
      .toEqual(['V1', 'V2']);
  });

  it('unwraps a byte cast, as LogLevel uses', () => {
    expect(parseJavaEnum('enum X {\n    Error((byte)1),\n    Warning((byte)2);\n}'))
      .toEqual({ Error: 1, Warning: 2 });
  });

  it('refuses to return an empty map', () => {
    expect(() => parseJavaEnum('enum X { }')).toThrow(/missed the source/);
  });
});
