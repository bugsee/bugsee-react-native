import {
  parseAndroidKeys,
  parseIosKeys,
  parseAndroidDescriptors,
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

  // Declaration order is reversed here, so a result that merely reflects Set
  // insertion order (rather than a real sort) fails this one.
  it('sorts keys that are not already in declaration order', () => {
    expect(parseIosKeys(`
NSString *const BugseeOptionZ = @"com.bugsee.option.z";
NSString *const BugseeOptionA = @"com.bugsee.option.a";
`)).toEqual(['com.bugsee.option.a', 'com.bugsee.option.z']);
  });

  it('reads a key with no space around the "="', () => {
    expect(parseIosKeys('NSString *const BugseeOptionX=@"com.bugsee.option.x";'))
      .toEqual(['com.bugsee.option.x']);
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

  it('reads a constant with no space around the "="', () => {
    expect(parseAndroidKeys('String CaptureLogs="com.bugsee.option.capture.logs";'))
      .toEqual(['com.bugsee.option.capture.logs']);
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
    expect(() => splitByPlatform([], android)).toThrow(
      'one platform produced an empty key list, which means the parser missed '
        + 'the source rather than that the platform has no options',
    );
    expect(() => splitByPlatform(ios, [])).toThrow(/empty/i);
  });

  // Every input is declared out of alphabetical order, so a bucket that
  // merely reflects filter/insertion order (rather than being actually
  // sorted) fails this for at least one of the three buckets.
  it('sorts each bucket, not just the filter order', () => {
    expect(splitByPlatform(
      ['s2', 's1', 'i2', 'i1'],
      ['s2', 's1', 'a2', 'a1'],
    )).toEqual({
      shared: ['s1', 's2'],
      ios: ['i1', 'i2'],
      android: ['a1', 'a2'],
    });
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

  it('unwraps a byte cast with a space before the value', () => {
    expect(parseJavaEnum('enum X {\n    Error((byte) 1);\n}')).toEqual({ Error: 1 });
  });

  it('accepts trailing whitespace before the separator', () => {
    expect(parseJavaEnum('enum X {\n    A(1) ,\n    B(2) ;\n}')).toEqual({ A: 1, B: 2 });
  });

  it('accepts whitespace between the value and the closing parenthesis', () => {
    expect(parseJavaEnum('enum X {\n    A(1 ),\n    B(2 );\n}')).toEqual({ A: 1, B: 2 });
  });

  // The body is sliced from the enum's opening "{": text before it (e.g. a
  // constant declared on an enclosing class) must not be scanned too.
  it('ignores a 4-space-indented constant declared before the enum body', () => {
    expect(Object.keys(parseJavaEnum(
      '    Decoy(9);\npublic enum X {\n    Real(1);\n}',
    ))).toEqual(['Real']);
  });

  // A constant is only read at the true start of its line: four spaces
  // appearing later in a line (here, inside a comment) do not count.
  it('does not read a constant from a run of spaces that is not at the start of its line', () => {
    expect(Object.keys(parseJavaEnum(
      'enum X {\n    // pad    Fake(9);\n    Real(1);\n}',
    ))).toEqual(['Real']);
  });

  it('refuses to return an empty map', () => {
    expect(() => parseJavaEnum('enum X { }')).toThrow(/missed the source/);
  });
});

describe('parseAndroidDescriptors', () => {
  const keys = { Duration: 'com.bugsee.option.config.duration',
                 CaptureVideoQuality: 'com.bugsee.option.capture.video.quality' };
  const enums = { VideoQuality: { Default: 0, Medium: 1, High: 2 } };

  it('reads key, declared type and default', () => {
    expect(parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(Options.Duration, Integer.class, 60);',
      keys, enums,
    )).toEqual([{
      key: 'com.bugsee.option.config.duration',
      type: 'int',
      default: 60,
      module: 'bugsee-android',
      hidden: false,
    }]);
  });

  // The spec stores an enum default as the CONSTANT NAME, not its number.
  it('describes an enum option with its constants', () => {
    const [option] = parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(Options.CaptureVideoQuality, VideoQuality.class, VideoQuality.Default);',
      keys, enums,
    );
    expect(option).toEqual({
      key: 'com.bugsee.option.capture.video.quality',
      type: 'enum',
      default: 'Default',
      module: 'bugsee-android',
      hidden: false,
      enum: { name: 'VideoQuality', values: { Default: 0, Medium: 1, High: 2 } },
    });
  });

  it('marks an option hidden from its fourth argument', () => {
    const [option] = parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister("com.bugsee.option.$$ENDPOINT", String.class, null, true);',
      keys, enums,
    );
    expect(option?.hidden).toBe(true);
    expect(option?.default).toBeNull();
  });

  // Registrations wrap across lines in the real source, and a pattern that
  // assumes one space between tokens silently matches none of them -- which
  // reads as "this SDK registers no options", not as a parse bug.
  it('reads a registration wrapped across lines', () => {
    expect(parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(\n    Options.Duration,\n    Integer.class,\n    60\n);',
      keys, enums,
    )).toEqual([{
      key: 'com.bugsee.option.config.duration',
      type: 'int',
      default: 60,
      module: 'bugsee-android',
      hidden: false,
    }]);
  });

  it('reads a registration with irregular spacing', () => {
    expect(parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(  Options.Duration ,  Integer.class ,  60  ) ;',
      keys, enums,
    )[0]?.default).toBe(60);
  });

  it('reads a registration with no spacing at all', () => {
    expect(parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(Options.Duration,Integer.class,60);',
      keys, enums,
    )[0]?.default).toBe(60);
  });

  it('skips a constant it has no key for, rather than inventing one', () => {
    expect(parseAndroidDescriptors(
      'OptionDescriptor.createAndRegister(Options.Unknown, boolean.class, true);'
      + 'OptionDescriptor.createAndRegister(Options.Duration, Integer.class, 60);',
      keys, enums,
    ).map((o) => o.key)).toEqual(['com.bugsee.option.config.duration']);
  });

  it.each([
    ['float', 'Float.class', '0.5f', 'float', 0.5],
    ['double', 'Double.class', '-1.25', 'float', -1.25],
    ['string', 'String.class', '"abc"', 'string', 'abc'],
    ['negative int', 'Integer.class', '-7', 'int', -7],
    ['boolean false', 'boolean.class', 'false', 'boolean', false],
    ['unmapped java type', 'Weird.class', 'null', 'string', null],
    // Every JAVA_TYPES entry, not just the ones the cases above happen to
    // exercise: each Java spelling of a type maps to its own manifest type.
    ['lowercase int', 'int.class', '5', 'int', 5],
    ['long', 'long.class', '5', 'int', 5],
    ['Long', 'Long.class', '5', 'int', 5],
    ['Boolean', 'Boolean.class', 'true', 'boolean', true],
    ['lowercase float', 'float.class', '0.5f', 'float', 0.5],
    ['lowercase double', 'double.class', '1.5', 'float', 1.5],
    ['Map', 'Map.class', 'null', 'map', null],
    ['List', 'List.class', 'null', 'list', null],
    // Each of these pins one literal-parsing regex to the exact text it is
    // meant to match, not merely a substring of it -- the literal is left as
    // the raw fallback (or falls to the enum-constant reading, which shares
    // the same "word.word" shape) rather than being misread as a number.
    ['int anchor: text before trailing digits', 'Weird.class', 'Q-5', 'string', 'Q-5'],
    ['float anchor: text before a decimal', 'Weird.class', 'Q1.5', 'string', '5'],
    ['float anchor: text after a decimal', 'Weird.class', '1.5xyz', 'string', '5xyz'],
    ['more than one digit before the decimal point', 'Double.class', '12.5', 'float', 12.5],
    ['quoted-string anchor: text before the opening quote', 'Weird.class', 'X"abc"', 'string', 'X"abc"'],
    ['quoted-string anchor: text after the closing quote', 'Weird.class', '"abc"Y', 'string', '"abc"Y'],
    ['enum-constant anchor: text before the qualifier', 'Weird.class', '!Foo.Bar', 'string', '!Foo.Bar'],
    ['enum-constant anchor: text after the constant name', 'Weird.class', 'Foo.Bar!', 'string', 'Foo.Bar!'],
  ])('reads a %s default', (_name, declared, literal, type, expected) => {
    const [option] = parseAndroidDescriptors(
      `OptionDescriptor.createAndRegister(Options.Duration, ${declared}, ${literal});`,
      keys, enums,
    );
    expect(option?.type).toBe(type);
    expect(option?.default).toEqual(expected);
  });

  it('refuses to return nothing', () => {
    expect(() => parseAndroidDescriptors('// nothing', keys, enums))
      .toThrow(/missed the source/);
  });

  // Real shape from OptionsDescriptors.java: a deprecated-but-still-honoured
  // option registers through createAndRegisterDeprecated, not
  // createAndRegister -- a caller relying on the surface this parser
  // extracts would otherwise silently lose it, exactly what happened to
  // com.bugsee.option.capture.webview.domain-allowlist when 7.3.0-SNAPSHOT
  // deprecated it. Wrapped in its own private method, per the real source,
  // to prove a text-wide scan finds it there too.
  describe('a deprecated option, registered via createAndRegisterDeprecated', () => {
    const deprecatedKeys = {
      ...keys,
      WebViewDomainAllowlist: 'com.bugsee.option.capture.webview.domain-allowlist',
    };
    const SOURCE = `
final class OptionsDescriptors {
    @SuppressWarnings("deprecation")
    private static void registerDeprecatedWebViewDomainAllowlist() {
        OptionDescriptor.createAndRegisterDeprecated(
                Options.WebViewDomainAllowlist, String.class, "", "7.1.2");
    }

    static {
        OptionDescriptor.createAndRegister(Options.Duration, Integer.class, 60);
        registerDeprecatedWebViewDomainAllowlist();
    }
}`;

    it('is present in the extracted options, not dropped', () => {
      const result = parseAndroidDescriptors(SOURCE, deprecatedKeys, enums);
      expect(result.map((o) => o.key)).toEqual(
        expect.arrayContaining([
          'com.bugsee.option.config.duration',
          'com.bugsee.option.capture.webview.domain-allowlist',
        ]),
      );
    });

    it('carries the deprecation, per the spec shape { since }', () => {
      const result = parseAndroidDescriptors(SOURCE, deprecatedKeys, enums);
      const option = result.find(
        (o) => o.key === 'com.bugsee.option.capture.webview.domain-allowlist',
      );
      expect(option).toEqual({
        key: 'com.bugsee.option.capture.webview.domain-allowlist',
        type: 'string',
        default: '',
        module: 'bugsee-android',
        hidden: false,
        deprecated: { since: '7.1.2' },
      });
    });

    it('still finds a non-deprecated option registered alongside it', () => {
      const result = parseAndroidDescriptors(SOURCE, deprecatedKeys, enums);
      const option = result.find((o) => o.key === 'com.bugsee.option.config.duration');
      expect(option?.deprecated).toBeUndefined();
    });

    // A deprecated option can itself be an enum -- the same enum-lookup and
    // shape rules apply as for a live registration.
    it('describes a deprecated enum option with its constants', () => {
      const [option] = parseAndroidDescriptors(
        'OptionDescriptor.createAndRegisterDeprecated('
          + 'Options.CaptureVideoQuality, VideoQuality.class, VideoQuality.Default, "7.0.0");',
        keys, enums,
      );
      expect(option).toEqual({
        key: 'com.bugsee.option.capture.video.quality',
        type: 'enum',
        default: 'Default',
        module: 'bugsee-android',
        hidden: false,
        deprecated: { since: '7.0.0' },
        enum: { name: 'VideoQuality', values: { Default: 0, Medium: 1, High: 2 } },
      });
    });

    // A deprecated option declared with a type the manifest has no mapping
    // for falls back to "string", same as a live registration.
    it('falls back to "string" for a deprecated option of an unmapped java type', () => {
      const [option] = parseAndroidDescriptors(
        'OptionDescriptor.createAndRegisterDeprecated(Options.Duration, Weird.class, null, "7.0.0");',
        keys, enums,
      );
      expect(option?.type).toBe('string');
    });

    // The same "no key, no invented entry" rule applies to a deprecated
    // registration as to a live one.
    it('skips a deprecated registration it has no key for', () => {
      const result = parseAndroidDescriptors(
        'OptionDescriptor.createAndRegisterDeprecated(Options.Unknown, String.class, "", "7.0.0");'
          + 'OptionDescriptor.createAndRegisterDeprecated(Options.Duration, String.class, "", "7.0.0");',
        keys, enums,
      );
      expect(result.map((o) => o.key)).toEqual(['com.bugsee.option.config.duration']);
    });

    // The key can also be given as a quoted string, same as a live
    // registration, rather than only through an Options.* constant.
    it('reads a deprecated registration whose key is a quoted string', () => {
      const [option] = parseAndroidDescriptors(
        'OptionDescriptor.createAndRegisterDeprecated('
          + '"com.bugsee.option.$$ENDPOINT", String.class, "", "7.0.0");',
        keys, enums,
      );
      expect(option?.key).toBe('com.bugsee.option.$$ENDPOINT');
    });

    it('reads a deprecated registration with irregular spacing', () => {
      expect(parseAndroidDescriptors(
        'OptionDescriptor.createAndRegisterDeprecated(  Options.Duration ,  String.class ,  ""'
          + ' ,  "7.0.0"  ) ;',
        keys, enums,
      )[0]).toEqual({
        key: 'com.bugsee.option.config.duration',
        type: 'string',
        default: '',
        module: 'bugsee-android',
        hidden: false,
        deprecated: { since: '7.0.0' },
      });
    });
  });
});
