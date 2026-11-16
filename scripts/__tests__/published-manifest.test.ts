import {
  ENUM_TS_NAMES,
  MANIFEST_BASE,
  checkAccessors,
  checkPublished,
  manifestUrl,
  parseManifest,
  type Accessor,
  type AccessorCheckInput,
  type CheckInput,
  type PublishedManifest,
  type PublishedOption,
} from '../published-manifest';

const option = (key: string, extra: Partial<PublishedOption> = {}): PublishedOption => ({
  key,
  type: 'boolean',
  ...extra,
});

const manifest = (
  options: PublishedOption[],
  extra: Partial<PublishedManifest> = {},
): PublishedManifest => ({
  manifestVersion: 1,
  sdk: 'android',
  sdkVersion: '7.4.2',
  options,
  ...extra,
});

const input = (extra: Partial<CheckInput> = {}): CheckInput => ({
  platform: 'android',
  pinnedVersion: '7.4.2',
  published: manifest([option('a'), option('b')]),
  knownKeys: ['a', 'b'],
  ...extra,
});

describe('manifestUrl', () => {
  it('points at the immutable per-release file', () => {
    expect(manifestUrl(MANIFEST_BASE, 'ios', '7.0.0')).toBe(
      'https://download.bugsee.com/sdk/options/ios/7.0.0.json',
    );
  });

  it('does not double the slash when the base ends in one', () => {
    expect(manifestUrl('http://x/y/', 'android', '1')).toBe('http://x/y/android/1.json');
    expect(manifestUrl('http://x/y///', 'android', '1')).toBe('http://x/y/android/1.json');
  });
});

describe('parseManifest', () => {
  it('reads a manifest', () => {
    expect(parseManifest(JSON.stringify(manifest([option('a')])), 'm').options).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['null', 'null'],
    ['a number', '3'],
    ['a list', '[]'],
    ['no sdk', JSON.stringify({ manifestVersion: 1, sdkVersion: '1', options: [] })],
    ['no version', JSON.stringify({ manifestVersion: 1, sdk: 'ios', options: [] })],
    ['no options', JSON.stringify({ manifestVersion: 1, sdk: 'ios', sdkVersion: '1' })],
    ['options that are not a list', JSON.stringify({ manifestVersion: 1, sdk: 'ios', sdkVersion: '1', options: {} })],
  ])('refuses %s, naming the source', (_name, text) => {
    expect(() => parseManifest(text, 'the-source')).toThrow(/the-source/);
  });

  it.each([
    ['a later version', 2],
    ['no version', undefined],
    ['a version that is a string', '1'],
  ])('refuses %s, saying which version it found', (_name, version) => {
    const text = JSON.stringify({ manifestVersion: version, sdk: 'ios', sdkVersion: '1', options: [] });
    expect(() => parseManifest(text, 'the-source')).toThrow(/manifestVersion .*this check reads version 1/);
  });

  it('names the version it found', () => {
    expect(() => parseManifest(JSON.stringify({ manifestVersion: 2, sdk: 'a', sdkVersion: '1', options: [] }), 's')).toThrow(
      's is manifestVersion 2; this check reads version 1',
    );
  });

  const withRow = (row: unknown): string =>
    JSON.stringify({ manifestVersion: 1, sdk: 'ios', sdkVersion: '1', options: [{ key: 'a', type: 'boolean' }, row] });

  it.each([
    ['a row that is not an object', 'x', /option #1 is not an object/],
    ['a row that is a list', [], /option #1 is not an object/],
    ['a row with no key', { type: 'boolean' }, /option #1 has no key/],
    ['a row with an empty key', { key: '', type: 'boolean' }, /option #1 has no key/],
    ['a row with no type', { key: 'b' }, /option #1 \(b\) has no type/],
    ['a hidden flag that is not a boolean', { key: 'b', type: 'boolean', hidden: 'yes' }, /\(b\) has a hidden flag that is not a boolean/],
    ['an enum with no name', { key: 'b', type: 'enum', enum: { values: {} } }, /\(b\) has an enum without a name and values/],
    ['an enum with no values', { key: 'b', type: 'enum', enum: { name: 'E' } }, /\(b\) has an enum without a name and values/],
    ['an enum that is not an object', { key: 'b', type: 'enum', enum: 'E' }, /\(b\) has an enum without a name and values/],
  ])('refuses %s, naming the row', (_name, row, message) => {
    expect(() => parseManifest(withRow(row), 'the-source')).toThrow(message);
  });

  it('accepts a row with a hidden flag, a deprecation and an enum', () => {
    const text = withRow({ key: 'b', type: 'enum', hidden: false, deprecated: { since: '1' }, enum: { name: 'E', values: { A: 1 } } });
    expect(parseManifest(text, 's').options).toHaveLength(2);
  });
});

describe('checkPublished', () => {
  it('is empty when the published manifest and the package agree', () => {
    expect(checkPublished(input())).toEqual([]);
  });

  it('reports a manifest for another platform', () => {
    expect(checkPublished(input({ published: manifest([option('a'), option('b')], { sdk: 'ios' }) }))).toEqual([
      'the manifest is for sdk "ios", not "android"',
    ]);
  });

  it('reports a manifest for another version than the pin', () => {
    expect(
      checkPublished(input({ published: manifest([option('a'), option('b')], { sdkVersion: '7.5.0' }) })),
    ).toEqual(['the manifest is for 7.5.0, but native-versions.json pins 7.4.2']);
  });

  it('reports an option the SDK registers and the package does not list', () => {
    const problems = checkPublished(input({ published: manifest([option('a'), option('b'), option('c')]) }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the android SDK registers c');
    expect(problems[0]).toContain('option-keys.json');
  });

  it('does not complain about a key this package lists and the SDK does not register', () => {
    // The package can have options of its own that the SDK ignores and only the wrapper acts on.
    expect(checkPublished(input({ knownKeys: ['a', 'b', 'wrapper-only'] }))).toEqual([]);
  });

  it('lists several problems in key order', () => {
    const problems = checkPublished(
      input({ published: manifest([option('z'), option('y')]), knownKeys: ['b', 'a'] }),
    );
    expect(problems.map((p) => p.match(/\bregisters (\w+)/)?.[1])).toEqual(['y', 'z']);
  });

  it('leaves hidden internals out of the key comparison, in both directions', () => {
    expect(
      checkPublished(
        input({ published: manifest([option('a'), option('b'), option('$$WRAPPER', { hidden: true })]) }),
      ),
    ).toEqual([]);
  });

  it('still counts a published option whose hidden flag is false', () => {
    expect(
      checkPublished(input({ published: manifest([option('a'), option('b'), option('c', { hidden: false })]) })),
    ).toHaveLength(1);
  });

  describe('against the committed Android manifest', () => {
    const committed = (options: PublishedOption[]) => input({ committed: options });

    it('is empty when every option matches', () => {
      expect(checkPublished(committed([option('a'), option('b')]))).toEqual([]);
    });

    it('reports an option the committed manifest lacks', () => {
      expect(checkPublished(committed([option('a')]))).toEqual([
        'android-options-manifest.json is missing b',
      ]);
    });

    it('does not complain about an option the committed manifest has and the SDK does not', () => {
      expect(checkPublished(committed([option('a'), option('b'), option('x')]))).toEqual([]);
    });

    it('reports a default that differs', () => {
      const published = manifest([option('a'), option('b', { default: 20480 })]);
      const problems = checkPublished({ ...input({ published }), committed: [option('a'), option('b', { default: '1024 * 20' })] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('differs from the published manifest for b');
      expect(problems[0]).toContain('20480');
    });

    it('reads an absent default as null, as the SDK manifests write it', () => {
      const published = manifest([option('a'), option('b', { default: null })]);
      expect(checkPublished({ ...input({ published }), committed: [option('a'), option('b')] })).toEqual([]);
    });

    it('names the committed file in its messages', () => {
      expect(checkPublished({ ...input(), committed: [option('a')], committedName: 'ios-options-manifest.json' })).toEqual([
        'ios-options-manifest.json is missing b',
      ]);
    });

    it('reports a type that differs, which is what a parser misreading looks like', () => {
      const problems = checkPublished(committed([option('a'), option('b', { type: 'string' })]));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('differs from the published manifest for b');
      expect(problems[0]).toContain('"type":"string"');
    });

    it('reports a hidden flag that differs', () => {
      expect(checkPublished(committed([option('a'), option('b', { hidden: true })]))).toHaveLength(1);
    });

    it('reports a deprecation the committed manifest does not carry', () => {
      const published = manifest([option('a'), option('b', { deprecated: { since: '7.1.2' } })]);
      expect(checkPublished({ ...input({ published }), committed: [option('a'), option('b')] })).toHaveLength(1);
    });

    it('treats a deprecation as a flag, not by its text', () => {
      const published = manifest([option('a'), option('b', { deprecated: { since: '7.1.2' } })]);
      expect(
        checkPublished({
          ...input({ published }),
          committed: [option('a'), option('b', { deprecated: { since: '7.2.0' } })],
        }),
      ).toEqual([]);
    });

    it('reports an enum whose constants differ', () => {
      const withEnum = (values: Record<string, number>) =>
        option('b', { type: 'enum', enum: { name: 'E', values } });
      const published = manifest([option('a'), withEnum({ A: 1, B: 2 })]);
      expect(checkPublished({ ...input({ published }), committed: [option('a'), withEnum({ A: 1, B: 3 })] })).toHaveLength(1);
    });

    it('ignores the order an enum lists its constants in', () => {
      const withEnum = (values: Record<string, number>) =>
        option('b', { type: 'enum', enum: { name: 'E', values } });
      const published = manifest([option('a'), withEnum({ A: 1, B: 2 })]);
      expect(checkPublished({ ...input({ published }), committed: [option('a'), withEnum({ B: 2, A: 1 })] })).toEqual([]);
    });

    it('reports an enum that is missing, and one that is renamed', () => {
      const published = manifest([option('a'), option('b', { type: 'enum', enum: { name: 'E', values: { A: 1 } } })]);
      expect(
        checkPublished({ ...input({ published }), committed: [option('a'), option('b', { type: 'enum' })] }),
      ).toHaveLength(1);
      expect(
        checkPublished({
          ...input({ published }),
          committed: [option('a'), option('b', { type: 'enum', enum: { name: 'Other', values: { A: 1 } } })],
        }),
      ).toHaveLength(1);
    });

    it('compares hidden options too, since the committed manifest carries them', () => {
      const published = manifest([option('a'), option('b'), option('$$X', { hidden: true })]);
      expect(checkPublished({ ...input({ published }), committed: [option('a'), option('b')] })).toEqual([
        'android-options-manifest.json is missing $$X',
      ]);
    });
  });
});

describe('checkAccessors', () => {
  const accessor = (key: string, type: string, extra: Partial<Accessor> = {}): Accessor => ({
    name: `${key}Accessor`,
    key,
    type,
    hasSetter: true,
    owner: 'base',
    ...extra,
  });
  const check = (extra: Partial<AccessorCheckInput> = {}): string[] =>
    checkAccessors({
      platform: 'android',
      pinnedVersion: '7.4.2',
      published: manifest([option('flag'), option('count', { type: 'int', default: 3 })]),
      accessors: [accessor('flag', 'boolean'), accessor('count', 'number')],
      noAccessor: {},
      enums: {},
      withheld: {},
      ...extra,
    });

  it('is empty when every published option has a fitting accessor with a setter', () => {
    expect(check()).toEqual([]);
  });

  it('names a missing option with its type and default, and where to add it', () => {
    const problems = check({ accessors: [accessor('flag', 'boolean')] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('MISSING OPTION count (int, default 3)');
    expect(problems[0]).toContain('the android SDK 7.4.2 manifest');
    expect(problems[0]).toContain('AndroidLaunchOptions (or BugseeLaunchOptions)');
    expect(problems[0]).toContain('noAccessor.ts');
  });

  it('names the iOS class for an iOS manifest', () => {
    expect(check({ platform: 'ios', accessors: [] })[0]).toContain('IOSLaunchOptions');
  });

  it('shows a missing enum option as its enum and constant default', () => {
    const published = manifest([option('mode', { type: 'enum', default: 'V2', enum: { name: 'VideoMode', values: { V2: 2 } } })]);
    expect(check({ published, accessors: [] })[0]).toContain('MISSING OPTION mode (enum VideoMode, default "V2")');
  });

  it('shows a missing option with no default as null', () => {
    expect(check({ published: manifest([option('flag')]), accessors: [] })[0]).toContain('default null');
  });

  it('reports every missing option, in key order', () => {
    const problems = check({ accessors: [] });
    expect(problems.map((p) => p.match(/MISSING OPTION (\w+)/)?.[1])).toEqual(['count', 'flag']);
  });

  it('skips an option that deliberately has no accessor', () => {
    expect(check({ accessors: [accessor('flag', 'boolean')], noAccessor: { count: 'internal' } })).toEqual([]);
  });

  it('ignores a hidden option', () => {
    const published = manifest([option('flag'), option('$$X', { hidden: true })]);
    expect(check({ published, accessors: [accessor('flag', 'boolean')] })).toEqual([]);
  });

  it('does not complain about an accessor for an option the SDK does not register', () => {
    // An option of the wrapper's own: sent, ignored by the SDK, acted on in React Native.
    expect(check({ accessors: [accessor('flag', 'boolean'), accessor('count', 'number'), accessor('rn-only', 'string')] })).toEqual([]);
  });

  it('reports a getter with no setter', () => {
    const problems = check({ accessors: [accessor('flag', 'boolean', { hasSetter: false }), accessor('count', 'number')] });
    expect(problems).toEqual(['flag' + 'Accessor (flag) has a getter but no setter, so the option cannot be set']);
  });

  it.each([
    ['boolean', 'number'],
    ['int', 'string'],
    ['float', 'boolean'],
    ['string', 'number'],
  ])('reports a %s option declared %s', (sdkType, declared) => {
    const published = manifest([option('x', { type: sdkType })]);
    const problems = check({ published, accessors: [accessor('x', declared)] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`is declared ${declared}, but the SDK type is ${sdkType}`);
  });

  it.each([
    ['int', 'number'],
    ['float', 'number'],
    ['string', 'string'],
    ['boolean', 'boolean'],
  ])('accepts a %s option declared %s', (sdkType, declared) => {
    expect(check({ published: manifest([option('x', { type: sdkType })]), accessors: [accessor('x', declared)] })).toEqual([]);
  });

  it('accepts a union that includes the SDK type', () => {
    expect(check({ published: manifest([option('x', { type: 'int' })]), accessors: [accessor('x', 'number | undefined')] })).toEqual([]);
    expect(check({ published: manifest([option('x', { type: 'int' })]), accessors: [accessor('x', 'Level | number')] })).toEqual([]);
  });

  it('reports an option type this package cannot represent', () => {
    const problems = check({ published: manifest([option('x', { type: 'map' })]), accessors: [accessor('x', 'object')] });
    expect(problems[0]).toContain('is a map option, which this package cannot represent');
  });

  describe('enums', () => {
    const published = (name: string, values: Record<string, unknown>) =>
      manifest([option('level', { type: 'enum', enum: { name, values } })]);

    it('accepts an enum whose constants match, by value', () => {
      expect(
        check({
          published: published('LogLevel', { Error: 1, Warning: 2 }),
          accessors: [accessor('level', 'LogLevel')],
          enums: { LogLevel: { Error: 1, Warning: 2 } },
        }),
      ).toEqual([]);
    });

    it('compares numeric enums by value, since the SDKs name members differently', () => {
      expect(
        check({
          platform: 'ios',
          published: published('BugseeSeverityLevel', { Low: 1, Blocker: 5 }),
          accessors: [accessor('level', 'IssueSeverity')],
          enums: { IssueSeverity: { VeryLow: 1, Blocker: 5 } },
        }),
      ).toEqual([]);
    });

    it('accepts a union with a plain number, the shape two older accessors keep', () => {
      expect(
        check({
          published: published('LogLevel', { Error: 1 }),
          accessors: [accessor('level', 'LogLevel | number')],
          enums: { LogLevel: { Error: 1 } },
        }),
      ).toEqual([]);
    });

    it('reports a constant the SDK has and the package lacks', () => {
      const problems = check({
        published: published('LogLevel', { Error: 1, Warning: 2, Verbose: 5 }),
        accessors: [accessor('level', 'LogLevel')],
        enums: { LogLevel: { Error: 1, Warning: 2 } },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('LogLevel has the constants [1, 2] but LogLevel in the SDK has [1, 2, 5]');
    });

    it('reports a constant the package has and the SDK lacks', () => {
      expect(
        check({
          published: published('LogLevel', { Error: 1 }),
          accessors: [accessor('level', 'LogLevel')],
          enums: { LogLevel: { Error: 1, Extra: 9 } },
        }),
      ).toHaveLength(1);
    });

    it('does not count a member the package withholds on purpose', () => {
      expect(
        check({
          published: published('FrameRate', { Low: 1, Raw: 4 }),
          accessors: [accessor('level', 'FrameRate')],
          enums: { FrameRate: { Low: 1 } },
          withheld: { FrameRate: { Raw: 4 } },
        }),
      ).toEqual([]);
    });

    it('compares a string-valued enum by constant name, which is what crosses the bridge', () => {
      const leak = published('MemoryLeakMode', { FAST: 'Fast', DEEP: 'Deep' });
      expect(
        check({ published: leak, accessors: [accessor('level', 'MemoryLeakMode')], enums: { MemoryLeakMode: { Fast: 'FAST', Deep: 'DEEP' } } }),
      ).toEqual([]);
      expect(
        check({ published: leak, accessors: [accessor('level', 'MemoryLeakMode')], enums: { MemoryLeakMode: { Fast: 'FAST' } } }),
      ).toHaveLength(1);
    });

    it('reports an accessor not declared as the enum', () => {
      const problems = check({
        published: published('LogLevel', { Error: 1 }),
        accessors: [accessor('level', 'number')],
        enums: { LogLevel: { Error: 1 } },
      });
      expect(problems[0]).toContain('is declared number, but the SDK type is the enum LogLevel (LogLevel)');
    });

    it('reports an SDK enum this package has no TypeScript name for', () => {
      expect(check({ published: published('BugseeNew', { A: 1 }), accessors: [accessor('level', 'number')] })[0]).toContain(
        'the SDK enum BugseeNew, which has no TypeScript enum here (add it to ENUM_TS_NAMES)',
      );
    });

    it('reports a TypeScript enum that enums.ts does not export', () => {
      expect(
        check({ published: published('LogLevel', { Error: 1 }), accessors: [accessor('level', 'LogLevel')], enums: {} })[0],
      ).toContain('uses LogLevel, which is not exported from enums.ts');
    });

    it('maps each SDK enum name to one TypeScript enum', () => {
      expect(ENUM_TS_NAMES.BugseeSeverityLevel).toBe('IssueSeverity');
      expect(ENUM_TS_NAMES.BugseeStyle).toBe('ReportingUIStyle');
      expect(ENUM_TS_NAMES.IssueSeverity).toBe('IssueSeverity');
    });
  });
});
