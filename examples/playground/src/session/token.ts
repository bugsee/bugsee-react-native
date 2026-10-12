const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAppToken = (s: string): boolean => UUID.test(s.trim());
export const tokenPrefix = (t: string): string => t.trim().toLowerCase().slice(0, 8);
export function parseQrPayload(raw: string): { ok: true; token: string } | { ok: false; error: 'Not a Bugsee app token' } {
  const m = /^BGSAPT:(\S+)$/.exec(raw.trim());
  return m && isAppToken(m[1]) ? { ok: true, token: m[1].toLowerCase() } : { ok: false, error: 'Not a Bugsee app token' };
}
