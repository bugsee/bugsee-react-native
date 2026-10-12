import { fetchProducts, postJson, DEMO, DemoHttpError } from '../src/demoApi';
afterEach(() => jest.restoreAllMocks());
test('uses the network when it answers', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ products: [{ id: 1, title: 'A', price: 1, description: 'd' }] }) }) as never;
  expect(await fetchProducts()).toEqual({ products: [{ id: 1, title: 'A', price: 1, description: 'd' }], source: 'network' });
  expect(global.fetch).toHaveBeenCalledWith(DEMO.PRODUCTS, expect.anything());
});
test.each([['rejects', () => Promise.reject(new TypeError('Network request failed'))], ['429', () => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })]])(
  'falls back to the bundled mock when the request %s, but still makes it', async (_n, impl) => {
    global.fetch = jest.fn(impl) as never;
    const r = await fetchProducts();
    expect(r.source).toBe('mock');
    expect(r.products.length).toBeGreaterThanOrEqual(3);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
test('flaky mode fails every third load with a 500 after the request', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ products: [] }) }) as never;
  await expect(fetchProducts({ flaky: true, attempt: 2 })).rejects.toBeInstanceOf(DemoHttpError);
  await expect(fetchProducts({ flaky: true, attempt: 1 })).resolves.toBeTruthy();
});
test('postJson sends JSON and parses the reply, null when not JSON', async () => {
  global.fetch = jest.fn().mockResolvedValue({ status: 201, text: async () => '{"a":1}' }) as never;
  expect(await postJson('https://x', { b: 2 }, { 'X-T': '1' })).toEqual({ status: 201, json: { a: 1 } });
  expect(global.fetch).toHaveBeenCalledWith('https://x', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-T': '1' }, body: '{"b":2}' });
  global.fetch = jest.fn().mockResolvedValue({ status: 500, text: async () => 'oops' }) as never;
  expect(await postJson('https://x', {})).toEqual({ status: 500, json: null });
});
