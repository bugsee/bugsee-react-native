import { classifyPulledZip, evictedBeforePull, peekBytes } from '../../examples/bare/e2e/bundles';

// A minimal complete zip: local header, then an end-of-central-directory record.
const LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const complete = (body = 100): Buffer => Buffer.concat([LOCAL, Buffer.alloc(body, 1), EOCD]);

describe('classifyPulledZip', () => {
  it('a complete zip is ok', () => {
    expect(classifyPulledZip(complete())).toBe('ok');
  });

  it('a zip whose end-of-central-directory record is far from the start is still ok', () => {
    expect(classifyPulledZip(complete(5_000_000))).toBe('ok');
  });

  it('nothing at all is empty (a failed cat over exec-out)', () => {
    expect(classifyPulledZip(Buffer.alloc(0))).toBe('empty');
  });

  it("cat's own error text is error-text", () => {
    expect(classifyPulledZip(Buffer.from('cat: files/bugsee_data/bundles/x.bundle.zip: No such file or directory\n'))).toBe('error-text');
    expect(classifyPulledZip(Buffer.from('run-as: package not debuggable: com.bareexample\n'))).toBe('error-text');
  });

  it('malformed bytes that merely contain the word error are not-a-zip, not a failed cat', () => {
    expect(classifyPulledZip(Buffer.from('this bundle had an error in it, and was not found complete'))).toBe('not-a-zip');
    expect(classifyPulledZip(Buffer.from('cat: files/x.bundle.zip: Permission denied\n'))).toBe('error-text');
  });

  it('other bytes that do not start like a zip are not-a-zip', () => {
    expect(classifyPulledZip(Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]))).toBe('not-a-zip');
  });

  it('a zip that starts right but has no end-of-central-directory record is truncated-zip: the only case that points at a short write', () => {
    expect(classifyPulledZip(Buffer.concat([LOCAL, Buffer.alloc(10_000, 2)]))).toBe('truncated-zip');
    expect(classifyPulledZip(complete().subarray(0, complete().length - 10))).toBe('truncated-zip');
  });
});

describe('peekBytes', () => {
  it('returns hex and text with dots for non-printables, at most n bytes', () => {
    const peek = peekBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41]), 4);
    expect(peek).toEqual({ hex: '504b0304', text: 'PK..' });
  });
});

describe('evictedBeforePull', () => {
  const listed = '-rw------- 1 u0_a1 u0_a1 55140 2026-10-19 07:28 abc.bundle.zip';

  it('skips a bundle that is gone from a valid listing when every pull was a failed cat', () => {
    expect(evictedBeforePull(['empty'], 'absent')).toBe(true);
    expect(evictedBeforePull(['error-text'], 'absent')).toBe(true);
    expect(evictedBeforePull(['error-text', 'error-text'], 'absent')).toBe(true);
    expect(evictedBeforePull(['empty', 'error-text'], 'absent')).toBe(true);
  });

  it('never skips a bundle that is still listed', () => {
    for (const kind of ['empty', 'error-text', 'not-a-zip', 'truncated-zip'] as const) {
      expect(evictedBeforePull([kind, kind], listed)).toBe(false);
    }
  });

  it('never skips a non-empty bad zip, even when the file is gone: a truncated zip is the one case that points at the SDK', () => {
    expect(evictedBeforePull(['truncated-zip'], 'absent')).toBe(false);
    expect(evictedBeforePull(['not-a-zip'], 'absent')).toBe(false);
  });

  it('a later eviction cannot hide an earlier truncated zip: the retry coming back empty is not enough to skip', () => {
    expect(evictedBeforePull(['truncated-zip', 'empty'], 'absent')).toBe(false);
    expect(evictedBeforePull(['truncated-zip', 'error-text'], 'absent')).toBe(false);
    expect(evictedBeforePull(['not-a-zip', 'empty'], 'absent')).toBe(false);
  });
});
