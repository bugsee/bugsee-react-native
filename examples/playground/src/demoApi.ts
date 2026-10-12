import { MOCK_PRODUCTS } from './demoMock';

export const DEMO = {
  ECHO: 'https://httpbin.org/anything',
  STATUS: (code: number) => `https://httpbin.org/status/${code}`,
  DELAY: (s: number) => `https://httpbin.org/delay/${s}`,
  BYTES: (n: number) => `https://httpbin.org/bytes/${n}`,
  DNS_FAIL: 'https://does-not-exist.invalid/',
  WS_ECHO: 'wss://echo.websocket.org',
  PRODUCTS: 'https://dummyjson.com/products?limit=12&select=id,title,price,thumbnail,description',
};

export interface Product {
  id: number;
  title: string;
  price: number;
  thumbnail?: string;
  description: string;
}

export class DemoHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
    this.name = 'DemoHttpError';
  }
}

export async function fetchProducts(
  opts: { flaky?: boolean; attempt?: number } = {},
): Promise<{ products: Product[]; source: 'network' | 'mock' }> {
  const flakyHit = !!opts.flaky && (opts.attempt ?? 0) % 3 === 2;
  const url = flakyHit ? DEMO.STATUS(500) : DEMO.PRODUCTS;
  const mock = { products: MOCK_PRODUCTS, source: 'mock' as const };
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (flakyHit) throw new DemoHttpError(500);
    if (!r.ok) return mock;
    const products = (await r.json()).products;
    return Array.isArray(products) ? { products, source: 'network' } : mock;
  } catch (e) {
    if (e instanceof DemoHttpError) throw e;
    if (flakyHit) throw new DemoHttpError(500);
    return mock;
  }
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json };
}
