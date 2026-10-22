jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';
import { jsonOf } from '../../__mocks__/native';

let native: typeof NativeMock;
let Bugsee: {
  setBreadcrumbFilter(callback?: ((crumb: Record<string, unknown>) => unknown) | null): void;
  setBreadcrumbUrlScrubber(scrubber?: unknown): void;
  addBreadcrumb(crumb: Record<string, unknown>): void;
};

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../../__mocks__/native'));
  Bugsee = require('../../index').default;
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function emit(requestId: string, crumb: Record<string, unknown>, addId?: string): void {
  native.emitBreadcrumbFilterRequest({
    requestId,
    crumbJson: JSON.stringify(crumb),
    ...(addId === undefined ? {} : { addId }),
  });
}

const httpCrumb = {
  category: 'http',
  level: 'info',
  type: 'http',
  timestamp: 9,
  data: {
    url: 'https://u:pw@api.example.com/v1/items?token=s3cret#frag',
    method: 'GET',
    body_size: 12,
  },
};

const cleanKept = jsonOf({
  category: 'http',
  type: 'http',
  level: 'info',
  data: { url: 'https://api.example.com/v1/items', method: 'GET', body_size: 12 },
});

describe('setBreadcrumbUrlScrubber', () => {
  it('costs nothing until it is turned on', () => {
    expect(native.setBreadcrumbFilterEnabled).not.toHaveBeenCalled();
  });

  it('installs the native filter on true and uninstalls on false', () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(true);
    Bugsee.setBreadcrumbUrlScrubber(false);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it.each([[null], [undefined]])('%s turns it off', (value) => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbUrlScrubber(value);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('rejects other types', () => {
    expect(() => Bugsee.setBreadcrumbUrlScrubber('yes')).toThrow(TypeError);
    expect(() => Bugsee.setBreadcrumbUrlScrubber({})).toThrow(/boolean or a function/);
    expect(native.setBreadcrumbFilterEnabled).not.toHaveBeenCalled();
  });

  it('keeps the native filter installed while a callback needs it', () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbUrlScrubber(false);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(true);
    Bugsee.setBreadcrumbFilter(null);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(false);
  });

  it('keeps the native filter installed while the scrubber needs it', () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    Bugsee.setBreadcrumbFilter(null);
    expect(native.setBreadcrumbFilterEnabled).toHaveBeenLastCalledWith(true);
  });

  it('with no callback keeps the crumb with a clean URL', async () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    emit('1', httpCrumb);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', cleanKept);
  });

  it('keeps a crumb that is not http unchanged', async () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    const crumb = {
      category: 'ui',
      level: 'warning',
      message: 'a?b=c',
      type: 'navigation',
      data: { url: 'https://h/p?q=1' },
    };
    emit('1', crumb);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith(
      '1',
      jsonOf({
        category: 'ui',
        message: 'a?b=c',
        type: 'navigation',
        level: 'warning',
        data: { url: 'https://h/p?q=1' },
      }),
    );
  });

  it('shows the app callback the cleaned URL, never the original', async () => {
    const seen: unknown[] = [];
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbFilter((crumb) => {
      seen.push(crumb.data);
      return crumb;
    });
    emit('1', httpCrumb);
    await flush();
    expect(seen).toEqual([
      { url: 'https://api.example.com/v1/items', method: 'GET', body_size: 12 },
    ]);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', cleanKept);
  });

  it('lets the callback drop the crumb after the scrub', async () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbFilter(() => null);
    emit('1', httpCrumb);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
  });

  it('runs the callback alone when the scrubber is off', async () => {
    Bugsee.setBreadcrumbFilter((crumb) => crumb);
    emit('1', httpCrumb);
    await flush();
    const replied = JSON.parse(native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string);
    expect(replied.data.url).toBe(httpCrumb.data.url);
  });

  it('uses a custom scrubber', async () => {
    Bugsee.setBreadcrumbUrlScrubber((url: string) => url.replace(/\/\/[^/]*/, '//host'));
    emit('1', httpCrumb);
    await flush();
    const replied = JSON.parse(native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string);
    expect(replied.data.url).toBe('https://host/v1/items?token=s3cret#frag');
  });

  it.each([
    ['throws', () => { throw new Error('boom'); }],
    ['returns a non-string', () => 42],
    ['returns undefined', () => undefined],
  ])('drops the crumb when a custom scrubber %s', async (_name, scrubber) => {
    const callback = jest.fn((crumb) => crumb);
    Bugsee.setBreadcrumbUrlScrubber(scrubber);
    Bugsee.setBreadcrumbFilter(callback);
    emit('1', httpCrumb);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledTimes(1);
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not run the scrubber for a crumb without a string url', async () => {
    const scrubber = jest.fn((url: string) => url);
    Bugsee.setBreadcrumbUrlScrubber(scrubber);
    emit('1', { category: 'http', level: 'info', type: 'http', data: { method: 'GET' } });
    await flush();
    expect(scrubber).not.toHaveBeenCalled();
    expect(native.replyBreadcrumbFilter.mock.calls[0]?.[1]).not.toBeNull();
  });

  it('fails closed after the scrubber is cleared with nothing else installed', async () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.setBreadcrumbUrlScrubber(false);
    emit('1', httpCrumb);
    await flush();
    expect(native.replyBreadcrumbFilter).toHaveBeenCalledWith('1', null);
  });

  it('scrubs an addBreadcrumb crumb with the scrubber installed at the add', async () => {
    Bugsee.setBreadcrumbUrlScrubber(true);
    Bugsee.addBreadcrumb({
      category: 'http',
      level: 'info',
      message: '',
      type: 'http',
      data: { url: 'https://h/p?token=1' },
    });
    const addId = native.addBreadcrumb.mock.calls.at(-1)?.[5];
    expect(typeof addId).toBe('string');
    // Cleared on the same turn: this crumb is still scrubbed.
    Bugsee.setBreadcrumbUrlScrubber(false);
    emit('1', {
      category: 'http',
      level: 'info',
      message: '',
      type: 'http',
      data: { url: 'https://h/p?token=1' },
    }, addId as string);
    await flush();
    const replied = JSON.parse(native.replyBreadcrumbFilter.mock.calls[0]?.[1] as string);
    expect(replied.data.url).toBe('https://h/p');
  });

  it('retains no add id when neither filter nor scrubber is installed', () => {
    Bugsee.addBreadcrumb({ category: 'a', level: 'info', message: 'm', type: 't' });
    expect(native.addBreadcrumb.mock.calls.at(-1)?.[5]).toBeNull();
  });
});
