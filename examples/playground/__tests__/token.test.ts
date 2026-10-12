import { isAppToken, parseQrPayload, tokenPrefix } from '../src/session/token';
const T = '1A2B3C4D-0000-4000-8000-000000000001';
test.each([
  [`BGSAPT:${T}`, true], [`  BGSAPT:${T}\n`, true], [`BGSAPT:${T.toLowerCase()}`, true],
  [T, false], [`bgsapt:${T}`, false], [`BGSAPT:${T}x`, false], [`https://x/?BGSAPT:${T}`, false], ['', false],
])('parseQrPayload(%j) ok=%s', (raw, ok) => {
  const r = parseQrPayload(raw);
  expect(r.ok).toBe(ok);
  if (r.ok) expect(r.token).toBe(T.toLowerCase());
  else expect(r.error).toBe('Not a Bugsee app token');
});
test('isAppToken and tokenPrefix', () => {
  expect(isAppToken(` ${T} `)).toBe(true);
  expect(isAppToken('nope')).toBe(false);
  expect(tokenPrefix(T)).toBe('1a2b3c4d');
});
