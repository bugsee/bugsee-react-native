import { cell, defaultCell, formatDefault, readHead, renderDoc, REFERENCE_MARKER } from '../launch-options-doc';
import type { AccessorInfo } from '../option-accessors';
import type { PublishedManifest, PublishedOption } from '../published-manifest';

const P = 'com.bugsee.option.';
const option = (key: string, extra: Partial<PublishedOption> = {}): PublishedOption => ({
  key: P + key,
  type: 'boolean',
  default: false,
  ...extra,
});
const manifest = (sdk: string, options: PublishedOption[]): PublishedManifest => ({
  manifestVersion: 1,
  sdk,
  sdkVersion: '1',
  options,
});
const accessor = (name: string, key: string, doc = 'Does it.', extra: Partial<AccessorInfo> = {}): AccessorInfo => ({
  name,
  key: P + key,
  type: 'boolean',
  doc,
  hasSetter: true,
  owner: 'base',
  ...extra,
});

const HEAD = `# Launch options\n\n${REFERENCE_MARKER}\n\nIntro.`;

describe('formatDefault', () => {
  it.each([
    [{ type: 'boolean', default: true }, '`true`'],
    [{ type: 'int', default: 20480 }, '`20480`'],
    [{ type: 'float', default: 0.01 }, '`0.01`'],
    [{ type: 'string', default: 'batched' }, '`"batched"`'],
    [{ type: 'string', default: '' }, '`""`'],
    [{ type: 'enum', default: 'Verbose' }, '`Verbose`'],
    [{ type: 'string', default: null }, 'unset'],
    [{ type: 'string' }, 'unset'],
  ])('writes %j as %s', (partial, expected) => {
    expect(formatDefault({ key: 'k', ...partial })).toBe(expected);
  });
});

describe('cell', () => {
  it('escapes a pipe so it cannot split the cell', () => {
    expect(cell('a | b')).toBe('a \\| b');
  });

  it('escapes a backslash first, so a written \\| is not read as an escaped pipe', () => {
    expect(cell('a\\b')).toBe('a\\\\b');
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
  });

  it('leaves plain text alone', () => {
    expect(cell('plain text')).toBe('plain text');
  });
});

describe('defaultCell', () => {
  it('writes one value when the platforms agree', () => {
    expect(defaultCell(option('a', { default: 1, type: 'int' }), option('a', { default: 1, type: 'int' }))).toBe('`1`');
  });

  it('labels both when they differ', () => {
    expect(defaultCell(option('a', { default: false }), option('a', { default: true }))).toBe('Android `false` · iOS `true`');
  });

  it('writes the one platform\'s value when only one has the option', () => {
    expect(defaultCell(option('a', { default: 7, type: 'int' }), undefined)).toBe('`7`');
    expect(defaultCell(undefined, option('a', { default: 9, type: 'int' }))).toBe('`9`');
  });
});

describe('readHead', () => {
  it('keeps everything before the first generated group', () => {
    expect(readHead(`${HEAD}\n\n### Capture\n\n| x |\n`)).toBe(`${HEAD}\n`);
  });

  it('refuses a document with no Reference heading', () => {
    expect(() => readHead('# nothing\n### Capture')).toThrow(/no "## Reference" heading/);
  });

  it('refuses a document with no group after the heading', () => {
    expect(() => readHead(`${HEAD}\n`)).toThrow(/no "###" group/);
  });
});

describe('renderDoc', () => {
  const render = (over: Partial<Parameters<typeof renderDoc>[0]> = {}): string =>
    renderDoc({
      head: HEAD,
      android: manifest('android', [option('capture.logs', { default: true }), option('detect.hang')]),
      ios: manifest('ios', [option('capture.logs', { default: true }), option('capture.avplayer')]),
      accessors: [
        accessor('captureLogs', 'capture.logs', 'Capture logs.'),
        accessor('detectAndReportHang', 'detect.hang', 'Detect hangs.', { owner: 'android' }),
        accessor('captureAVPlayer', 'capture.avplayer', 'Capture AVPlayer.', { owner: 'ios' }),
      ],
      noAccessor: { 'com.bugsee.option.$$X': 'internal' },
      ...over,
    });

  it('keeps the hand-written head and groups the options in order', () => {
    const doc = render();
    expect(doc.startsWith(`${HEAD}\n\n### Capture`)).toBe(true);
    expect(doc.indexOf('### Capture')).toBeLessThan(doc.indexOf('### Detection'));
    expect(doc.indexOf('### Detection')).toBeLessThan(doc.indexOf('### Not exposed on purpose'));
  });

  it('writes a row with the accessor, key, type, platforms, default and notes', () => {
    expect(render()).toContain(
      '| `captureLogs` | `com.bugsee.option.capture.logs` | `boolean` | iOS, Android | `true` | Capture logs. |',
    );
  });

  it('says which platform has an option that only one does', () => {
    const doc = render();
    expect(doc).toContain('| `detectAndReportHang` | `com.bugsee.option.detect.hang` | `boolean` | Android | `false` | Detect hangs. |');
    expect(doc).toContain('| `captureAVPlayer` | `com.bugsee.option.capture.avplayer` | `boolean` | iOS | `false` | Capture AVPlayer. |');
  });

  it('sorts the rows of a group by key', () => {
    const doc = render();
    expect(doc.indexOf('`captureAVPlayer`')).toBeLessThan(doc.indexOf('`captureLogs`'));
  });

  it('shows an enum by its SDK name, and a default that differs by platform', () => {
    const doc = render({
      android: manifest('android', [option('capture.logs.level', { type: 'enum', default: 'Verbose', enum: { name: 'LogLevel', values: {} } })]),
      ios: manifest('ios', [option('capture.logs.level', { type: 'enum', default: 'Info', enum: { name: 'BugseeLogLevel', values: {} } })]),
      accessors: [accessor('captureLogsLevel', 'capture.logs.level')],
    });
    expect(doc).toContain('`enum LogLevel`');
    expect(doc).toContain('Android `Verbose` · iOS `Info`');
  });

  it('documents an option of the package\'s own, which no SDK manifest has, instead of failing on it', () => {
    const doc = render({
      accessors: [accessor('rnOnly', 'capture.rn-only', 'Acted on in React Native.', { type: 'string' })],
      android: manifest('android', []),
      ios: manifest('ios', []),
    });
    expect(doc).toContain(
      '| `rnOnly` | `com.bugsee.option.capture.rn-only` | `string` | React Native only | unset | Acted on in React Native. |',
    );
  });

  it('flags a deprecated accessor in its notes', () => {
    const doc = render({
      accessors: [accessor('captureLogs', 'capture.logs', 'Capture logs.', { deprecated: 'Gone.' })],
      android: manifest('android', [option('capture.logs')]),
      ios: manifest('ios', []),
    });
    expect(doc).toContain('Capture logs. **Deprecated** — Gone. |');
  });

  it('escapes a pipe in a note so it cannot split the cell', () => {
    expect(render({ accessors: [accessor('captureLogs', 'capture.logs', 'a | b')] })).toContain('a \\| b');
  });

  it('lists what is not exposed, with the reason', () => {
    expect(render()).toContain('- `com.bugsee.option.$$X`: internal.');
  });

  it('skips a group with no accessors', () => {
    expect(render()).not.toContain('### Performance');
  });

  it('refuses an accessor whose key belongs to no documented group, rather than dropping it', () => {
    expect(() =>
      render({ accessors: [accessor('mystery', 'mystery.thing')], android: manifest('android', [option('mystery.thing')]) }),
    ).toThrow(/outside every documented group: com\.bugsee\.option\.mystery\.thing/);
  });

  it('ends with a newline and is stable when rendered twice from its own head', () => {
    const once = render();
    expect(once.endsWith('\n')).toBe(true);
    expect(render({ head: readHead(once) })).toBe(once);
  });
});
