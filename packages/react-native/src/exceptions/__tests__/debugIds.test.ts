import { DEBUG_IDS_MAX, currentDebugIds, readDebugIdMap } from '../debugIds';

const g = globalThis as unknown as { _bugseeDebugIds?: unknown };

afterEach(() => {
  delete g._bugseeDebugIds;
});

describe('readDebugIdMap', () => {
  it('an absent or non-object registration is an empty map', () => {
    expect(readDebugIdMap(undefined).size).toBe(0);
    expect(readDebugIdMap(null).size).toBe(0);
    expect(readDebugIdMap(42).size).toBe(0);
    expect(readDebugIdMap('x').size).toBe(0);
    expect(readDebugIdMap({}).size).toBe(0);
    expect(readDebugIdMap({ _bugseeDebugIds: null }).size).toBe(0);
    expect(readDebugIdMap({ _bugseeDebugIds: 'nope' }).size).toBe(0);
    expect(readDebugIdMap({ _bugseeDebugIds: 7 }).size).toBe(0);
  });

  it("a Hermes registration stack keys its id by the top frame's file", () => {
    const stack =
      'Error\n    at inject (address at index.android.bundle:1:10)\n    at other (address at other.js:2:3)';
    const map = readDebugIdMap({
      _bugseeDebugIds: { [stack]: '8a1c2f4e-0d3b-5e6f-9a7b-1c2d3e4f5a6b' },
    });

    expect(map.get('index.android.bundle')).toBe(
      '8a1c2f4e-0d3b-5e6f-9a7b-1c2d3e4f5a6b',
    );
    expect(map.size).toBe(1);
    expect(map.has(stack)).toBe(false);
  });

  it('a Metro-URL registration keys by the URL', () => {
    const url =
      'http://localhost:8081/index.bundle//&platform=android&dev=true&minify=false';
    const stack = `Error\n    at inject (${url}:1234:20)`;
    const map = readDebugIdMap({
      _bugseeDebugIds: { [stack]: 'metro-id' },
    });

    expect(map.get(url)).toBe('metro-id');
    expect(map.size).toBe(1);
  });

  it('a non-string id is skipped', () => {
    const stack = 'Error\n    at inject (good.js:1:1)';
    const map = readDebugIdMap({
      _bugseeDebugIds: {
        [stack]: 42,
        ['Error\n    at inject (also.js:1:1)']: 'ok',
      },
    });

    expect(map.has('good.js')).toBe(false);
    expect(map.get('also.js')).toBe('ok');
  });

  it('an unparseable stack is skipped', () => {
    const map = readDebugIdMap({
      _bugseeDebugIds: {
        'not a stack at all': 'id-1',
        'Error: only a header': 'id-2',
      },
    });

    expect(map.size).toBe(0);
  });

  it('a native top frame with no file is skipped', () => {
    const map = readDebugIdMap({
      _bugseeDebugIds: {
        'Error\n    at forEach (native)': 'native-id',
        'Error\n    at real (real.js:1:1)': 'real-id',
      },
    });

    expect(map.has('native')).toBe(false);
    expect(map.get('real.js')).toBe('real-id');
    expect(map.size).toBe(1);
  });

  it('the first registration wins when two stacks share a file key', () => {
    const map = readDebugIdMap({
      _bugseeDebugIds: {
        'Error\n    at a (shared.js:1:1)': 'first',
        'Error\n    at b (shared.js:2:2)': 'second',
      },
    });

    expect(map.get('shared.js')).toBe('first');
    expect(map.size).toBe(1);
  });

  it('stops at 64 entries', () => {
    const registration: Record<string, string> = {};
    for (let i = 0; i < DEBUG_IDS_MAX + 10; i += 1) {
      registration[`Error\n    at f (file${i}.js:1:1)`] = `id-${i}`;
    }

    const map = readDebugIdMap({ _bugseeDebugIds: registration });

    expect(map.size).toBe(DEBUG_IDS_MAX);
    expect(map.has(`file${DEBUG_IDS_MAX}.js`)).toBe(false);
    expect(map.get('file0.js')).toBe('id-0');
    expect(map.get(`file${DEBUG_IDS_MAX - 1}.js`)).toBe(`id-${DEBUG_IDS_MAX - 1}`);
  });

  it('never throws on a hostile registration object', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('ownKeys boom');
        },
      },
    );

    expect(() => readDebugIdMap({ _bugseeDebugIds: hostile })).not.toThrow();
    expect(readDebugIdMap({ _bugseeDebugIds: hostile }).size).toBe(0);
  });

  it('never throws when reading _bugseeDebugIds itself throws', () => {
    const globalObject = {};
    Object.defineProperty(globalObject, '_bugseeDebugIds', {
      get(): unknown {
        throw new Error('getter boom');
      },
    });

    expect(() => readDebugIdMap(globalObject)).not.toThrow();
    expect(readDebugIdMap(globalObject).size).toBe(0);
  });
});

describe('currentDebugIds', () => {
  it('currentDebugIds recomputes when a bundle registers later', () => {
    jest.resetModules();
    const { currentDebugIds: fresh } =
      require('../debugIds') as typeof import('../debugIds');

    g._bugseeDebugIds = {
      ['Error\n    at a (a.js:1:1)']: 'id-a',
    };
    const first = fresh();
    expect(first.get('a.js')).toBe('id-a');
    expect(first.size).toBe(1);

    (g._bugseeDebugIds as Record<string, string>)['Error\n    at b (b.js:1:1)'] =
      'id-b';
    const second = fresh();
    expect(second.get('b.js')).toBe('id-b');
    expect(second.get('a.js')).toBe('id-a');
    expect(second.size).toBe(2);
    expect(second).not.toBe(first);
  });

  it('reuses the cached map when the key count is unchanged', () => {
    jest.resetModules();
    const { currentDebugIds: fresh } =
      require('../debugIds') as typeof import('../debugIds');

    g._bugseeDebugIds = {
      ['Error\n    at a (a.js:1:1)']: 'id-a',
    };
    const first = fresh();
    const second = fresh();
    expect(second).toBe(first);

    // Same key count, different value: still the cached map (count-only).
    (g._bugseeDebugIds as Record<string, string>)[
      'Error\n    at a (a.js:1:1)'
    ] = 'id-changed';
    expect(fresh()).toBe(first);
    expect(fresh().get('a.js')).toBe('id-a');
  });

  it('treats a non-object _bugseeDebugIds as empty for the cache key count', () => {
    jest.resetModules();
    const { currentDebugIds: fresh } =
      require('../debugIds') as typeof import('../debugIds');

    g._bugseeDebugIds = {
      ['Error\n    at a (a.js:1:1)']: 'id-a',
    };
    expect(fresh().get('a.js')).toBe('id-a');

    g._bugseeDebugIds = 'not-an-object';
    // key count collapses to 0, so the map is recomputed empty.
    expect(fresh().size).toBe(0);
  });

  it('never throws on a hostile registration object', () => {
    jest.resetModules();
    const { currentDebugIds: fresh } =
      require('../debugIds') as typeof import('../debugIds');

    g._bugseeDebugIds = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('ownKeys boom');
        },
      },
    );

    expect(() => fresh()).not.toThrow();
    expect(fresh().size).toBe(0);
  });
});
