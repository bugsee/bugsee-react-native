import {
  MANIFEST_BASE,
  checkPublished,
  manifestUrl,
  parseManifest,
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
    ['no sdk', JSON.stringify({ sdkVersion: '1', options: [] })],
    ['no version', JSON.stringify({ sdk: 'ios', options: [] })],
    ['no options', JSON.stringify({ sdk: 'ios', sdkVersion: '1' })],
    ['options that are not a list', JSON.stringify({ sdk: 'ios', sdkVersion: '1', options: {} })],
  ])('refuses %s, naming the source', (_name, text) => {
    expect(() => parseManifest(text, 'the-source')).toThrow(/the-source/);
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

  it('reports a key the package lists and the SDK does not register', () => {
    const problems = checkPublished(input({ knownKeys: ['a', 'b', 'gone'] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('lists gone for android');
    expect(problems[0]).toContain('silently ignored');
  });

  it('lists several problems in key order', () => {
    const problems = checkPublished(
      input({ published: manifest([option('z'), option('y')]), knownKeys: ['b', 'a'] }),
    );
    expect(problems.map((p) => p.match(/\b(registers|lists) (\w+)/)?.[2])).toEqual(['y', 'z', 'a', 'b']);
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

    it('reports an option the published manifest lacks', () => {
      expect(checkPublished(committed([option('a'), option('b'), option('x')]))).toEqual([
        'android-options-manifest.json has x, which the published manifest does not',
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
