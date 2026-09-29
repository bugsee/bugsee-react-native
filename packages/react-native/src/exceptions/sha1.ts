/**
 * A minimal, dependency-free SHA-1 (FIPS 180-4). React Native has no built-in
 * crypto module, and pulling one in is not worth it for a single, non-secret
 * digest used only to compute the exception `signature` (R2).
 */

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }

    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return bytes;
}

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** `arr[i]`, defaulting to 0 -- every index used below is in bounds by construction. */
function at(arr: number[], i: number): number {
  return arr[i] ?? 0;
}

function pad(bytes: number[]): number[] {
  const bitLength = bytes.length * 8;
  const padded = bytes.slice();

  padded.push(0x80);
  while (padded.length % 64 !== 56) {
    padded.push(0);
  }

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const part of [high, low]) {
    padded.push((part >>> 24) & 0xff, (part >>> 16) & 0xff, (part >>> 8) & 0xff, part & 0xff);
  }

  return padded;
}

function digest(bytes: number[]): number[] {
  const padded = pad(bytes);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);

  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      const offset = block + t * 4;
      w[t] =
        (at(padded, offset) << 24) |
        (at(padded, offset + 1) << 16) |
        (at(padded, offset + 2) << 8) |
        at(padded, offset + 3);
    }
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl(at(w, t - 3) ^ at(w, t - 8) ^ at(w, t - 14) ^ at(w, t - 16), 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let t = 0; t < 80; t += 1) {
      let f: number;
      let k: number;

      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + at(w, t)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return [h0, h1, h2, h3, h4];
}

function toHex(words: number[]): string {
  let hex = '';
  for (const word of words) {
    hex += (word >>> 0).toString(16).padStart(8, '0');
  }
  return hex;
}

/** SHA-1 of `text`'s UTF-8 bytes (never its UTF-16 code units), lowercase hex. */
export function sha1Hex(text: string): string {
  return toHex(digest(utf8Bytes(text)));
}
