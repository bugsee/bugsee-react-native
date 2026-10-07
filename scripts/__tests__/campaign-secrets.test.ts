import {
  FOUND_MARKER,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_TOKEN,
  describeFinding,
  describeKnown,
  isKnownFile,
  parseKnown,
  needlesOf,
  scanBytes,
  secretsOf,
} from '../campaign-secrets';

/** Campaign N-29: no token in any kept file, found in every form it could take. */
const REAL = '1f2e3d4c-5b6a-4789-8abc-def012345678';

describe('needlesOf', () => {
  it('spells a dashed token every way: case, no dashes, UTF-8/16LE/16BE and base64', () => {
    const forms = needlesOf([{ label: 'staging', value: REAL }]).map(n => n.form);
    expect(forms).toEqual(
      expect.arrayContaining([
        'utf8',
        'utf16le',
        'utf16be',
        'base64',
        'utf8 upper',
        'utf8 no-dash',
        'utf16le no-dash upper',
        'base64 no-dash',
      ]),
    );
    // Lower is the same bytes as given for this token: listed once.
    expect(forms).not.toContain('utf8 lower');
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('a token without dashes has no no-dash forms', () => {
    const forms = needlesOf([{ label: 'k', value: 'ABCDEFGHIJKLMNOPQRS' }]).map(n => n.form);
    expect(forms.some(form => form.includes('no-dash'))).toBe(false);
    expect(forms).toContain('utf8 lower');
  });

  it('skips a value too short to scan for, after trimming', () => {
    expect(needlesOf([{ label: 'short', value: ' '.repeat(4) + 'x'.repeat(MIN_SECRET_LENGTH - 1) + ' ' }])).toEqual([]);
    expect(needlesOf([{ label: 'ok', value: 'x'.repeat(MIN_SECRET_LENGTH) }]).length).toBeGreaterThan(0);
  });

  it('encodes each form as stated', () => {
    const needles = needlesOf([{ label: 'k', value: 'Abcdefghijklmnop' }]);
    const of = (form: string) => needles.find(n => n.form === form)!.bytes;
    expect(of('utf8')).toEqual(Buffer.from('Abcdefghijklmnop'));
    expect(of('utf16le')).toEqual(Buffer.from('Abcdefghijklmnop', 'utf16le'));
    expect(of('utf16be')[0]).toBe(0);
    expect(of('utf16be')[1]).toBe('A'.charCodeAt(0));
    expect(of('base64').toString()).toBe(Buffer.from('Abcdefghijklmnop').toString('base64').replace(/=+$/, ''));
    expect(of('utf8 upper')).toEqual(Buffer.from('ABCDEFGHIJKLMNOP'));
    expect(needles.every(n => n.label === 'k')).toBe(true);
  });
});

describe('scanBytes', () => {
  const needles = needlesOf([{ label: 'staging', value: REAL }]);

  it('finds the token in each form, with its offset', () => {
    const plain = scanBytes(Buffer.from(`xx${REAL}yy`), needles);
    expect(plain).toEqual([{ label: 'staging', form: 'utf8', offset: 2 }]);
    expect(scanBytes(Buffer.from(`--${REAL.toUpperCase()}`), needles)).toEqual([{ label: 'staging', form: 'utf8 upper', offset: 2 }]);
    expect(scanBytes(Buffer.from(REAL.replace(/-/g, '')), needles).map(f => f.form)).toEqual(['utf8 no-dash']);
    expect(scanBytes(Buffer.from(REAL, 'utf16le'), needles).map(f => f.form)).toEqual(['utf16le']);
    expect(scanBytes(Buffer.from(REAL, 'utf16le').swap16(), needles).map(f => f.form)).toEqual(['utf16be']);
    expect(scanBytes(Buffer.from(Buffer.from(REAL).toString('base64')), needles).map(f => f.form)).toEqual(['base64']);
  });

  it('finds every occurrence up to the limit', () => {
    const data = Buffer.from(`${REAL} ${REAL} ${REAL}`);
    expect(scanBytes(data, needles).map(f => f.offset)).toEqual([0, REAL.length + 1, 2 * (REAL.length + 1)]);
    expect(scanBytes(data, needles, 2)).toHaveLength(2);
  });

  it('finds nothing in clean data', () => {
    expect(scanBytes(Buffer.from('token=placeholder endpoint=https://127.0.0.1:9'), needles)).toEqual([]);
  });
});

describe('secretsOf', () => {
  it('always includes the placeholder', () => {
    expect(secretsOf([])).toEqual([{ label: 'placeholder', value: PLACEHOLDER_TOKEN }]);
  });

  it('reads credentials.json and bugsee.properties, labelled by origin', () => {
    const secrets = secretsOf([
      {
        origin: 'staging',
        json: JSON.stringify({ ios: REAL, android: ` ${REAL.toUpperCase()} `, endpoint: 'https://apidev.bugsee.com', token: 'short' }),
        properties: `# c\napp_token = ${'a'.repeat(20)}\nplugin.appToken: ${'b'.repeat(20)}\nother=${'c'.repeat(20)}\n`,
      },
    ]);
    expect(secrets).toEqual([
      { label: 'placeholder', value: PLACEHOLDER_TOKEN },
      { label: 'staging credentials.json ios', value: REAL },
      { label: 'staging credentials.json android', value: REAL.toUpperCase() },
      { label: 'staging bugsee.properties app_token', value: 'a'.repeat(20) },
      { label: 'staging bugsee.properties plugin.appToken', value: 'b'.repeat(20) },
    ]);
  });

  it('merges the same value from several places into one, naming them all', () => {
    const secrets = secretsOf([
      { origin: 'app', json: JSON.stringify({ ios: PLACEHOLDER_TOKEN, appToken: REAL }), properties: `app_token=${REAL}` },
    ]);
    expect(secrets).toEqual([
      { label: 'placeholder = app credentials.json ios', value: PLACEHOLDER_TOKEN },
      { label: 'app credentials.json appToken = app bugsee.properties app_token', value: REAL },
    ]);
  });

  it('refuses unreadable JSON, naming the origin', () => {
    expect(() => secretsOf([{ origin: 'x', json: '{' }])).toThrow('x: credentials.json is not JSON');
  });

  it('tolerates a JSON null', () => {
    expect(secretsOf([{ origin: 'x', json: 'null' }])).toHaveLength(1);
  });
});

describe('describeFinding', () => {
  it('names where and how, never the value, and carries the marker the CLI fails on', () => {
    const line = describeFinding('/tmp/run.log', { label: 'staging credentials.json android', form: 'utf8', offset: 42 });
    expect(line).toBe('SECRET-SCAN FOUND staging credentials.json android (utf8) in /tmp/run.log at byte 42');
    expect(FOUND_MARKER.test(line)).toBe(true);
    expect(FOUND_MARKER.test('SECRET-SCAN pulled bundles: 3 file(s), 0 finding(s)')).toBe(false);
  });
});

describe('known files (E2E_SECRET_SCAN_KNOWN)', () => {
  it('parses a comma list, trimming and dropping empties', () => {
    expect(parseKnown(undefined)).toEqual([]);
    expect(parseKnown('')).toEqual([]);
    expect(parseKnown(' .apptoken , ,log.json')).toEqual(['.apptoken', 'log.json']);
  });

  it('matches by base name only, on either separator', () => {
    expect(isKnownFile('/tmp/b/x/.apptoken', ['.apptoken'])).toBe(true);
    expect(isKnownFile('C:\\b\\.apptoken', ['.apptoken'])).toBe(true);
    expect(isKnownFile('/tmp/.apptoken.bak', ['.apptoken'])).toBe(false);
    expect(isKnownFile('.apptoken', [])).toBe(false);
  });

  it('a known finding is printed as KNOWN, which the CLI does not fail on', () => {
    const line = describeKnown('/b/.apptoken', { label: 'placeholder', form: 'utf8', offset: 0 });
    expect(line).toBe('SECRET-SCAN KNOWN placeholder (utf8) in /b/.apptoken at byte 0');
    expect(FOUND_MARKER.test(line)).toBe(false);
  });
});
