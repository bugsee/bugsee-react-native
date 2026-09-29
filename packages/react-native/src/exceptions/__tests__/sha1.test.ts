import { sha1Hex } from '../sha1';

describe('sha1Hex', () => {
  it('hashes the empty string', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('hashes "abc"', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('hashes a two-block input', () => {
    expect(
      sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });

  it('hashes UTF-8, not UTF-16', () => {
    expect(sha1Hex('é')).toBe('bf15be717ac1b080b4f1c456692825891ff5073d');
    expect(sha1Hex('😀')).toBe('9c533688a979a858cbd6a43c9f91aba624651f18');
  });

  it('hashes a 3-byte-range code point (U+4E2D)', () => {
    expect(sha1Hex('中')).toBe('0869071c92c0c11170ac87036bebedb52ea0c993');
  });

  it('a surrogate pair not at the very start of the string still forms one code point', () => {
    expect(sha1Hex('x😀')).toBe('03b3caef482d99f36d64159d9663b6ff6f3d6943');
  });

  it('treats an unpaired surrogate as its own code unit, never crashing', () => {
    expect(sha1Hex('a\uD800')).toBe('7db36e52d930af97665b4f55c20e03e5b9382244');
    expect(sha1Hex('\uDC00a')).toBe('1afdb9daefc51f18c9e0e5adf88046d0011d9a63');
    expect(sha1Hex('\uD800x')).toBe('1721e2bd1db361bd1352dab61b5d1b2bfb79432c');
  });

  it('pairs a surrogate exactly at the boundary values (0xD800/0xDC00 and 0xDBFF/0xDFFF)', () => {
    expect(sha1Hex(String.fromCharCode(0xd800, 0xdc00))).toBe(
      '65e574df4c26a5034e26490200ef9040b9ad3a26',
    );
    expect(sha1Hex(String.fromCharCode(0xdbff, 0xdfff))).toBe(
      '445c38f9b9f2c07b0b51efd181654b980dd624b2',
    );
  });

  it('never forms a pair from two lone low surrogates, or from a non-surrogate followed by one', () => {
    expect(sha1Hex(String.fromCharCode(0xdc00, 0xdc00))).toBe(
      'bd703d84253dbcb77708105658556561adcdb140',
    );
    expect(sha1Hex(`a${String.fromCharCode(0xdc00)}`)).toBe(
      '35fcadaf2934c27064329901dece58c174d63f58',
    );
  });

  it('does not form a pair when the second unit is outside the low-surrogate range', () => {
    expect(sha1Hex(String.fromCharCode(0xd800, 0xe000))).toBe(
      '1531fab61aa77e9920d9ac68c52f7a63395d52ae',
    );
  });

  it('hashes the exact 1/2/3-byte UTF-8 length boundaries', () => {
    expect(sha1Hex(String.fromCharCode(0x7f))).toBe(
      '23833462f55515a900e016db2eb943fb474c19f6',
    );
    expect(sha1Hex(String.fromCharCode(0x7ff))).toBe(
      '300f01aa690f416a005dfb5fd24a7b2f3243f686',
    );
    expect(sha1Hex(String.fromCharCode(0xffff))).toBe(
      'c6d9a44d71abe180a4025ae4005313e09b917437',
    );
  });

  it('returns 40 lowercase hex characters', () => {
    const hex = sha1Hex('some arbitrary text');
    expect(hex).toMatch(/^[0-9a-f]{40}$/);
  });
});
