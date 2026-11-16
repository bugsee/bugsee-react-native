import { parseAccessors, readDoc } from '../option-accessors';

const accessor = (name: string, type: string, key: string, doc = ''): string => `
  ${doc}
  get ${name}(): ${type} | undefined {
    return this.$get('${key}');
  }
  set ${name}(value: ${type} | undefined) {
    this.$set('${key}', value);
  }
`;

describe('readDoc', () => {
  it('has no doc and no deprecation when there is no comment', () => {
    expect(readDoc(undefined)).toEqual({ doc: '' });
  });

  it('joins a multi-line comment into one line without the stars', () => {
    expect(readDoc('\n   * First line\n   * second line.\n   ')).toEqual({ doc: 'First line second line.' });
  });

  it('turns {@link X} into backticked X', () => {
    expect(readDoc(' see {@link LogLevel} and {@link FrameRate}. ')).toEqual({ doc: 'see `LogLevel` and `FrameRate`.' });
  });

  it('splits the @deprecated text from the summary', () => {
    expect(readDoc('\n   * Has no effect.\n   *\n   * @deprecated The SDK ignores it.\n   ')).toEqual({
      doc: 'Has no effect.',
      deprecated: 'The SDK ignores it.',
    });
  });

  it('collapses runs of whitespace', () => {
    expect(readDoc('a    b\n\n   *    c')).toEqual({ doc: 'a b c' });
  });
});

describe('parseAccessors', () => {
  it('reads name, key, declared type, doc and owner', () => {
    const [found] = parseAccessors(
      accessor('captureLogs', 'boolean', 'com.bugsee.option.capture.logs', '/**\n   * Capture logs.\n   */'),
      'base',
    );
    expect(found).toEqual({
      name: 'captureLogs',
      key: 'com.bugsee.option.capture.logs',
      type: 'boolean',
      doc: 'Capture logs.',
      hasSetter: true,
      owner: 'base',
    });
  });

  it('keeps a union type without the trailing undefined', () => {
    expect(parseAccessors(accessor('level', 'LogLevel | number', 'k'), 'android')[0]?.type).toBe('LogLevel | number');
  });

  it('reads an accessor with no doc comment', () => {
    expect(parseAccessors(accessor('x', 'string', 'k'), 'ios')[0]?.doc).toBe('');
  });

  it('carries a deprecation', () => {
    const source = accessor('old', 'boolean', 'k', '/**\n   * Does nothing.\n   *\n   * @deprecated Gone.\n   */');
    expect(parseAccessors(source, 'base')[0]).toMatchObject({ doc: 'Does nothing.', deprecated: 'Gone.' });
  });

  it('does not attach one accessor\'s comment to the next', () => {
    const found = parseAccessors(
      accessor('a', 'boolean', 'ka', '/**\n   * First.\n   */') + accessor('b', 'boolean', 'kb'),
      'base',
    );
    expect(found.map((f) => [f.name, f.doc])).toEqual([['a', 'First.'], ['b', '']]);
  });

  it('finds a getter with no setter, which a check then reports', () => {
    const source = `
  get lonely(): boolean | undefined {
    return this.$get('k');
  }
`;
    expect(parseAccessors(source, 'base')[0]?.hasSetter).toBe(false);
  });

  it('does not take another key\'s setter for this getter\'s', () => {
    const source = `
  get a(): boolean | undefined {
    return this.$get('ka');
  }
  set a(value: boolean | undefined) {
    this.$set('other', value);
  }
`;
    expect(parseAccessors(source, 'base')[0]?.hasSetter).toBe(false);
  });

  it('matches a key containing dots and $ literally', () => {
    const key = 'com.bugsee.option.$$ENDPOINT';
    expect(parseAccessors(accessor('endpoint', 'string', key), 'base')[0]?.hasSetter).toBe(true);
    const wrongDot = accessor('e', 'string', 'a.b').replace("this.$set('a.b'", "this.$set('aXb'");
    expect(parseAccessors(wrongDot, 'base')[0]?.hasSetter).toBe(false);
  });

  it('ignores a getter that does not read through $get with a literal key', () => {
    expect(parseAccessors("get e(): string | undefined {\n    return this.$get(SOME_CONSTANT);\n  }", 'base')).toEqual([]);
  });

  it('finds every accessor in a file', () => {
    expect(parseAccessors(accessor('a', 'boolean', 'ka') + accessor('b', 'number', 'kb'), 'base').map((f) => f.name)).toEqual(['a', 'b']);
  });
});
