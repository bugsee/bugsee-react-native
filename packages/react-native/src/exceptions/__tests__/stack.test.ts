import { cleanSource, fileKey, parseStack } from '../stack';

describe('parseStack', () => {
  it('parses a Hermes release frame (address at)', () => {
    const frames = parseStack(
      '    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)',
    );

    expect(frames).toEqual([
      {
        raw: '    at bugseeE2EThrowSite (address at index.android.bundle:1:20417)',
        file: 'address at index.android.bundle',
        methodName: 'bugseeE2EThrowSite',
        lineNumber: 1,
        column: 20417,
      },
    ]);
  });

  it('parses a Hermes frame from a Metro URL', () => {
    const line =
      '    at bugseeE2EThrowSite (http://localhost:8081/index.bundle?platform=android&dev=true&minify=false:2:20417)';
    const frames = parseStack(line);

    expect(frames).toEqual([
      {
        raw: line,
        file: 'http://localhost:8081/index.bundle?platform=android&dev=true&minify=false',
        methodName: 'bugseeE2EThrowSite',
        lineNumber: 2,
        column: 20417,
      },
    ]);
  });

  it('parses a native frame with no location', () => {
    const frames = parseStack('    at forEach (native)');

    expect(frames).toEqual([
      {
        raw: '    at forEach (native)',
        file: null,
        methodName: 'forEach',
        lineNumber: null,
        column: null,
      },
    ]);
  });

  it('parses a JSC frame (name@file:line:col)', () => {
    const frames = parseStack('global@app.bundle:100:20');

    expect(frames).toEqual([
      {
        raw: 'global@app.bundle:100:20',
        file: 'app.bundle',
        methodName: 'global',
        lineNumber: 100,
        column: 20,
      },
    ]);
  });

  it('parses a V8 frame (at name (file:line:col))', () => {
    const frames = parseStack('    at Object.foo (/path/to/file.js:10:15)');

    expect(frames).toEqual([
      {
        raw: '    at Object.foo (/path/to/file.js:10:15)',
        file: '/path/to/file.js',
        methodName: 'Object.foo',
        lineNumber: 10,
        column: 15,
      },
    ]);
  });

  it('parses a component-stack line (in X (at file:line))', () => {
    const frames = parseStack('    in MyComponent (at App.js:42)');

    expect(frames).toEqual([
      {
        raw: '    in MyComponent (at App.js:42)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: null,
      },
    ]);
  });

  it('skips the "Name: message" header and blank lines', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      '',
      '    at foo (/a.js:1:2)',
    ].join('\n');

    const frames = parseStack(stack);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: '/a.js', methodName: 'foo' });
  });

  it('parses a JSC frame with no name prefix (file:line:col)', () => {
    const frames = parseStack('app.bundle:7:8');

    expect(frames).toEqual([
      {
        raw: 'app.bundle:7:8',
        file: 'app.bundle',
        methodName: null,
        lineNumber: 7,
        column: 8,
      },
    ]);
  });

  it('parses a JSC frame with no column (file:line)', () => {
    const frames = parseStack('app.bundle:7');

    expect(frames).toEqual([
      { raw: 'app.bundle:7', file: 'app.bundle', methodName: null, lineNumber: 7, column: null },
    ]);
  });

  it('tolerates a missing space before the opening parenthesis (Chrome)', () => {
    const frames = parseStack('    at foo(/a.js:1:2)');

    expect(frames).toEqual([
      { raw: '    at foo(/a.js:1:2)', file: '/a.js', methodName: 'foo', lineNumber: 1, column: 2 },
    ]);
  });

  it('parses a Windows drive-letter path (Chrome)', () => {
    const frames = parseStack('    at foo (c:\\app\\file.js:1:2)');

    expect(frames).toEqual([
      {
        raw: '    at foo (c:\\app\\file.js:1:2)',
        file: 'c:\\app\\file.js',
        methodName: 'foo',
        lineNumber: 1,
        column: 2,
      },
    ]);
  });

  it('tolerates a missing closing parenthesis (Chrome)', () => {
    const frames = parseStack('    at foo (/a.js:1:2');

    expect(frames).toEqual([
      { raw: '    at foo (/a.js:1:2', file: '/a.js', methodName: 'foo', lineNumber: 1, column: 2 },
    ]);
  });

  it('does not treat a garbage-prefixed "at" line as a frame (Chrome)', () => {
    expect(parseStack('xat foo (/a.js:1:2)')).toEqual([]);
  });

  it('does not treat a garbage-prefixed "at" line as a frame (Hermes address)', () => {
    expect(parseStack('xat foo (address at index.android.bundle:1:2)')).toEqual([]);
  });

  it('rejects trailing garbage after the closing parenthesis (Hermes address)', () => {
    expect(
      parseStack('    at foo (address at index.android.bundle:1:2) trailing junk'),
    ).toEqual([]);
  });

  it('tolerates trailing whitespace, and only whitespace, after the closing parenthesis (Hermes address)', () => {
    const frames = parseStack('    at foo (address at index.android.bundle:1:2)   ');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: 'address at index.android.bundle' });
  });

  it('parses multi-digit line and column numbers (Hermes address)', () => {
    const frames = parseStack('    at foo (address at index.android.bundle:1234:5678)');

    expect(frames).toEqual([
      {
        raw: '    at foo (address at index.android.bundle:1234:5678)',
        file: 'address at index.android.bundle',
        methodName: 'foo',
        lineNumber: 1234,
        column: 5678,
      },
    ]);
  });

  it('requires a run of whitespace, not exactly one space (component stack)', () => {
    const frames = parseStack('    in  MyComponent  (at  App.js:42)');

    expect(frames).toEqual([
      {
        raw: '    in  MyComponent  (at  App.js:42)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: null,
      },
    ]);
  });

  it('parses a component-stack line with a multi-digit column', () => {
    const frames = parseStack('    in MyComponent (at App.js:42:17)');

    expect(frames).toEqual([
      {
        raw: '    in MyComponent (at App.js:42:17)',
        file: 'App.js',
        methodName: 'MyComponent',
        lineNumber: 42,
        column: 17,
      },
    ]);
  });

  it("defaults an empty component name to '<unknown>'", () => {
    const frames = parseStack('    in  (at App.js:1)');

    expect(frames[0]?.methodName).toBe('<unknown>');
  });

  it('rejects trailing garbage after the closing parenthesis (component stack)', () => {
    expect(parseStack('    in MyComponent (at App.js:42) trailing junk')).toEqual([]);
  });

  it('tolerates trailing whitespace, and only whitespace, after the closing parenthesis (component stack)', () => {
    const frames = parseStack('    in MyComponent (at App.js:42)   ');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ file: 'App.js', methodName: 'MyComponent' });
  });
});

describe('fileKey', () => {
  it('strips file:// and "address at " only', () => {
    expect(fileKey('file:///Users/x/Bundle.app/index.android.bundle')).toBe(
      '/Users/x/Bundle.app/index.android.bundle',
    );
    expect(fileKey('address at index.android.bundle')).toBe('index.android.bundle');
    expect(fileKey('index.android.bundle')).toBe('index.android.bundle');
  });

  it('strips them only as a genuine prefix, not wherever they occur', () => {
    expect(fileKey('xfile://something')).toBe('xfile://something');
    expect(fileKey('xaddress at foo')).toBe('xaddress at foo');
  });
});

describe('cleanSource', () => {
  it('strips an iOS .app prefix, the iOS data container and the Android data directory', () => {
    expect(
      cleanSource(
        '/private/var/containers/Bundle/Application/ABC-123/MyApp.app/main.jsbundle',
      ),
    ).toBe('main.jsbundle');

    expect(
      cleanSource(
        '/var/mobile/Containers/Data/Application/XYZ-456/Documents/CodePush/bundle.js',
      ),
    ).toBe('Documents/CodePush/bundle.js');

    expect(cleanSource('/data/user/42/com.example.foo/files/bundle.js')).toBe(
      'files/bundle.js',
    );
    expect(cleanSource('/data/data/com.example.foo/files/bundle.js')).toBe(
      'files/bundle.js',
    );
  });

  it("is '' for null", () => {
    expect(cleanSource(null)).toBe('');
  });

  it('also strips file:// and "address at " (steps 1-2)', () => {
    expect(cleanSource('file:///a/b.js')).toBe('/a/b.js');
    expect(cleanSource('address at index.android.bundle')).toBe('index.android.bundle');
  });

  it('strips the Android and iOS data-directory patterns only as a genuine prefix', () => {
    expect(cleanSource('prefix/data/data/com.example.foo/file.js')).toBe(
      'prefix/data/data/com.example.foo/file.js',
    );
    expect(cleanSource('prefix/data/user/0/com.example.foo/file.js')).toBe(
      'prefix/data/user/0/com.example.foo/file.js',
    );
    expect(
      cleanSource('prefix/var/mobile/Containers/Data/Application/ABC/file.js'),
    ).toBe('prefix/var/mobile/Containers/Data/Application/ABC/file.js');
  });

  it('strips an iOS .app bundle path only when it can start matching at the very beginning', () => {
    // `.` does not match a newline, so an anchored match cannot start before
    // one; without the anchor the pattern would instead match starting after it.
    expect(cleanSource('garbage\n/real/path/MyApp.app/main.js')).toBe(
      'garbage\n/real/path/MyApp.app/main.js',
    );
  });
});
