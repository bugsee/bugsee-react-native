import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about spans, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee, { BugseeSpanError, SpanErrorCode, SpanStatus } from '../index';
import { jsonOf, native } from '../__mocks__/native';

beforeEach(() => native.reset());

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: 'sp-1',
    spanId: 'span-1',
    traceId: 'trace-1',
    operation: 'user.flow',
    description: null,
    status: SpanStatus.OK,
    finished: false,
    attributesJson: '{}',
    ...overrides,
  };
}

let handleSeq = 0;

function freshHandle(): string {
  handleSeq += 1;
  return `sp-m-${handleSeq}`;
}

const DEAD = {
  name: 'BugseeSpanError',
  code: 'E_SPAN_HANDLE_DEAD',
  message: 'Bugsee span handle is dead; finish already released it',
};

describe('spans', () => {
  it('startTransaction crosses name, operation and null attributes', () => {
    native.startTransaction.mockReturnValue(
      wire({ name: 'checkout', sampled: true, operation: 'user.flow' }),
    );
    const txn = Bugsee.startTransaction('checkout', 'user.flow');
    expect(native.startTransaction).toHaveBeenCalledWith('checkout', 'user.flow', null);
    expect(txn.name).toBe('checkout');
    expect(txn.sampled).toBe(true);
    expect(txn.spanId).toBe('span-1');
    expect(txn.operation).toBe('user.flow');
    expect(txn.finished).toBe(false);
  });

  it('startTransaction crosses attributes as JSON text', () => {
    native.startTransaction.mockReturnValue(wire({ name: 'checkout', sampled: false }));
    Bugsee.startTransaction('checkout', 'user.flow', { retries: 2, ok: true, lane: 'a' });
    expect(native.startTransaction).toHaveBeenCalledWith(
      'checkout',
      'user.flow',
      jsonOf({ retries: 2, ok: true, lane: 'a' }),
    );
  });

  it('startSpan crosses operation and description', () => {
    native.startSpan.mockReturnValue(wire({ handle: 'sp-2', operation: 'db.query', description: 'users' }));
    const span = Bugsee.startSpan('db.query', 'users');
    expect(native.startSpan).toHaveBeenCalledWith('db.query', 'users');
    expect(span.operation).toBe('db.query');
    expect(span.description).toBe('users');
    expect('name' in span).toBe(false);
  });

  it('getActiveSpan is null when native has no handle', () => {
    native.getActiveSpan.mockReturnValue(wire({ handle: '' }));
    expect(Bugsee.getActiveSpan()).toBeNull();
  });

  it('getActiveSpan returns the span already held for that handle', () => {
    native.startTransaction.mockReturnValue(wire({ name: 'checkout', sampled: true }));
    native.getActiveSpan.mockReturnValue(wire({ name: 'checkout', sampled: true }));
    const txn = Bugsee.startTransaction('checkout', 'user.flow');
    expect(Bugsee.getActiveSpan()).toBe(txn);
  });

  it('finish releases the handle and a second finish does not cross', () => {
    native.startSpan.mockReturnValue(wire());
    native.spanFinish.mockReturnValue(['sp-1']);
    const span = Bugsee.startSpan('db.query');
    span.finish();
    expect(native.spanFinish).toHaveBeenCalledTimes(1);
    expect(native.spanFinish).toHaveBeenCalledWith('sp-1', 0, false);
    expect(span.finished).toBe(true);
    expect(() => span.finish()).toThrow(expect.objectContaining({ code: 'E_SPAN_HANDLE_DEAD' }));
    expect(native.spanFinish).toHaveBeenCalledTimes(1);
    expect(() => span.setName('later')).toThrow(
      expect.objectContaining({ code: 'E_SPAN_HANDLE_DEAD' }),
    );
    expect(native.spanSetName).not.toHaveBeenCalled();
  });

  it('finish(status) crosses the status by value', () => {
    native.startSpan.mockReturnValue(wire());
    native.spanFinish.mockReturnValue(['sp-1']);
    Bugsee.startSpan('db.query').finish(SpanStatus.Error);
    expect(native.spanFinish).toHaveBeenCalledWith('sp-1', SpanStatus.Error, true);
  });

  it('setName, setDescription, setAttribute and setStatus cross, and setName is the operation', () => {
    native.startSpan.mockReturnValue(wire());
    native.spanSetAttribute.mockReturnValue(true);
    const span = Bugsee.startSpan('db.query', null);
    span.setName('http.client').setDescription('GET').setAttribute('code', 200).setStatus(SpanStatus.OK);
    expect(native.spanSetName).toHaveBeenCalledWith('sp-1', 'http.client');
    expect(native.spanSetDescription).toHaveBeenCalledWith('sp-1', 'GET');
    expect(native.spanSetAttribute).toHaveBeenCalledWith('sp-1', 'code', '200');
    expect(native.spanSetStatus).toHaveBeenCalledWith('sp-1', SpanStatus.OK);
    expect(span.operation).toBe('http.client');
    expect(span.description).toBe('GET');
    expect(span.attributes).toEqual({ code: 200 });
    expect(span.status).toBe(SpanStatus.OK);
  });

  it('startChildSpan returns the child, and finishing the parent releases the child', () => {
    native.startTransaction.mockReturnValue(
      wire({ handle: 'sp-parent', name: 'checkout', sampled: true }),
    );
    native.spanStartChild.mockReturnValue(
      wire({ handle: 'sp-child', spanId: 'child', operation: 'db.query', description: 'users' }),
    );
    native.spanFinish.mockReturnValue(['sp-parent', 'sp-child']);
    const txn = Bugsee.startTransaction('checkout', 'user.flow');
    const child = txn.startChildSpan('db.query', 'users');
    expect(native.spanStartChild).toHaveBeenCalledWith('sp-parent', 'db.query', 'users');
    expect(child.spanId).toBe('child');
    txn.finish();
    expect(() => child.setAttribute('k', 'v')).toThrow(
      expect.objectContaining({ code: 'E_SPAN_HANDLE_DEAD' }),
    );
    expect(native.spanSetAttribute).not.toHaveBeenCalled();
  });

  it('the first finish returns even when native omits the handle', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle, spanId: 'first' }));
    native.spanFinish.mockReturnValue([]);
    const span = Bugsee.startSpan('db.query');
    expect(() => span.finish()).not.toThrow();
    expect(span.finished).toBe(true);
    expect(() => span.finish()).toThrow(expect.objectContaining({ code: 'E_SPAN_HANDLE_DEAD' }));
    expect(native.spanFinish).toHaveBeenCalledTimes(1);
    native.startSpan.mockReturnValue(wire({ handle, spanId: 'second' }));
    const again = Bugsee.startSpan('db.query');
    expect(again).not.toBe(span);
    expect(again.spanId).toBe('second');
    expect(again.finished).toBe(false);
  });

  it('a lone surrogate is well-formed, and a refused attribute is not cached', () => {
    native.startSpan.mockReturnValue(wire({ handle: freshHandle() }));
    const span = Bugsee.startSpan('db.query');
    native.spanSetAttribute.mockReturnValue(false);
    span.setAttribute('k', '\uD800');
    const sent = native.spanSetAttribute.mock.calls[0]?.[2] as string;
    expect(sent).not.toContain('\\ud800');
    expect(sent).toContain('\uFFFD');
    expect(span.attributes).toEqual({});
    native.spanSetAttribute.mockReturnValue(true);
    span.setAttribute('k', '\uD800');
    expect(span.attributes).toEqual({ k: '\uFFFD' });
  });

  it('the four setters return a value so codegen does not queue them', () => {
    const source = readFileSync(join(__dirname, '..', 'NativeBugsee.ts'), 'utf8');
    for (const name of ['spanSetName', 'spanSetDescription', 'spanSetAttribute', 'spanSetStatus']) {
      const declared = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*:\\s*([^;]+);`).exec(source);
      expect(declared).not.toBeNull();
      // `void` is queued. A Promise is queued too. Only a sync boolean
      // runs on the JS thread, ahead of spanFinish in the same turn.
      expect({ name, returns: declared![1]!.trim() }).toEqual({ name, returns: 'boolean' });
    }
  });

  it('rejects an empty operation before crossing', () => {
    expect(() => Bugsee.startSpan('')).toThrow(
      'Bugsee.startSpan requires operation to be a non-empty string',
    );
    expect(() => Bugsee.startTransaction('', 'user.flow')).toThrow(
      'Bugsee.startTransaction requires name to be a non-empty string',
    );
    expect(native.startSpan).not.toHaveBeenCalled();
    expect(native.startTransaction).not.toHaveBeenCalled();
  });

  it('names a dead-handle error and keeps the code', () => {
    const error = new BugseeSpanError(SpanErrorCode.HandleDead, 'gone');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BugseeSpanError');
    expect(error.message).toBe('gone');
    expect(error.code).toBe('E_SPAN_HANDLE_DEAD');
  });

  it('reads every transaction field, including a false sample and a finished flag', () => {
    const handle = freshHandle();
    native.startTransaction.mockReturnValue(
      wire({
        handle,
        name: 'checkout',
        sampled: false,
        spanId: 'sid',
        traceId: 'tid',
        operation: 'op',
        description: 'desc',
        status: SpanStatus.Timeout,
        finished: true,
        attributesJson: JSON.stringify({
          s: '',
          n: 0,
          neg: -2,
          ok: false,
          yes: true,
          t: 'x',
        }),
      }),
    );
    const txn = Bugsee.startTransaction('checkout', 'op');
    expect(txn.name).toBe('checkout');
    expect(txn.sampled).toBe(false);
    expect(txn.spanId).toBe('sid');
    expect(txn.traceId).toBe('tid');
    expect(txn.operation).toBe('op');
    expect(txn.description).toBe('desc');
    expect(txn.status).toBe(SpanStatus.Timeout);
    expect(txn.finished).toBe(true);
    expect(txn.attributes).toEqual({
      s: '',
      n: 0,
      neg: -2,
      ok: false,
      yes: true,
      t: 'x',
    });
    expect(txn.setName('next')).toBe(txn);
    expect(txn.operation).toBe('next');
    expect(txn.name).toBe('checkout');
    expect(txn.finished).toBe(true);
  });

  it('drops non-string wire fields and ignores a non-string transaction name', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue({
      handle,
      spanId: 1,
      traceId: false,
      operation: 2,
      description: 3,
      status: 'nope',
      finished: 1,
      attributesJson: 4,
      name: 5,
    });
    const span = Bugsee.startSpan('db.query');
    expect(span.spanId).toBe('');
    expect(span.traceId).toBe('');
    expect(span.operation).toBe('');
    expect(span.description).toBeNull();
    expect(span.status).toBe(SpanStatus.OK);
    expect(span.finished).toBe(false);
    expect(span.attributes).toEqual({});
    expect('name' in span).toBe(false);
  });

  it('keeps an empty description and treats bad attribute JSON as an empty map', () => {
    native.startSpan.mockReturnValue(wire({ handle: freshHandle(), description: '' }));
    expect(Bugsee.startSpan('db.query').description).toBe('');
    for (const attributesJson of ['{', 'null', '[1,"a"]', '"x"', '1', '{"a":null,"b":{"c":1},"d":[1]}']) {
      native.startSpan.mockReturnValue(wire({ handle: freshHandle(), attributesJson }));
      expect(Bugsee.startSpan('db.query').attributes).toEqual({});
    }
  });

  it('rejects a blank or non-string name, operation, key or description before crossing', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle }));
    const span = Bugsee.startSpan('db.query');
    expect(() => Bugsee.startSpan('   ')).toThrow(
      'Bugsee.startSpan requires operation to be a non-empty string',
    );
    expect(() => Bugsee.startSpan(1 as unknown as string)).toThrow(
      'Bugsee.startSpan requires operation to be a non-empty string',
    );
    expect(() => Bugsee.startTransaction('checkout', '')).toThrow(
      'Bugsee.startTransaction requires operation to be a non-empty string',
    );
    expect(() => Bugsee.startTransaction('   ', 'user.flow')).toThrow(
      'Bugsee.startTransaction requires name to be a non-empty string',
    );
    expect(() => Bugsee.startTransaction(1 as unknown as string, 'user.flow')).toThrow(
      'Bugsee.startTransaction requires name to be a non-empty string',
    );
    expect(() => span.setName('')).toThrow('Bugsee.setName requires name to be a non-empty string');
    expect(() => span.setName('   ')).toThrow('Bugsee.setName requires name to be a non-empty string');
    expect(() => span.setName(1 as unknown as string)).toThrow(
      'Bugsee.setName requires name to be a non-empty string',
    );
    expect(() => span.setAttribute('', true)).toThrow(
      'Bugsee.setAttribute requires key to be a non-empty string',
    );
    expect(() => span.setAttribute('   ', true)).toThrow(
      'Bugsee.setAttribute requires key to be a non-empty string',
    );
    expect(() => span.startChildSpan('')).toThrow(
      'Bugsee.startChildSpan requires operation to be a non-empty string',
    );
    expect(() => Bugsee.startSpan('db.query', 1 as unknown as string)).toThrow(
      'Bugsee span description must be a string or null',
    );
    expect(() => span.startChildSpan('db.query', 1 as unknown as string)).toThrow(
      'Bugsee span description must be a string or null',
    );
    expect(() => span.setDescription(1 as unknown as string)).toThrow(
      'Bugsee.setDescription requires a string or null',
    );
    expect(native.spanSetName).not.toHaveBeenCalled();
    expect(native.spanSetAttribute).not.toHaveBeenCalled();
    expect(native.spanSetDescription).not.toHaveBeenCalled();
    expect(native.spanStartChild).not.toHaveBeenCalled();
    expect(native.startSpan).toHaveBeenCalledTimes(1);
    expect(native.startTransaction).not.toHaveBeenCalled();
  });

  it('crosses null, omitted and empty descriptions, and returns each setter', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle, description: 'wire' }));
    native.spanSetAttribute.mockReturnValue(true);
    const span = Bugsee.startSpan('db.query');
    expect(native.startSpan).toHaveBeenCalledWith('db.query', null);
    native.startSpan.mockClear();
    Bugsee.startSpan('db.query', null);
    expect(native.startSpan).toHaveBeenCalledWith('db.query', null);
    native.startSpan.mockClear();
    Bugsee.startSpan('db.query', '');
    expect(native.startSpan).toHaveBeenCalledWith('db.query', '');
    expect(span.setDescription(null)).toBe(span);
    expect(span.description).toBeNull();
    expect(native.spanSetDescription).toHaveBeenCalledWith(handle, null);
    expect(span.setDescription('')).toBe(span);
    expect(span.description).toBe('');
    expect(span.setAttribute('b', false)).toBe(span);
    expect(span.setAttribute('n', 0)).toBe(span);
    expect(span.setAttribute('s', '')).toBe(span);
    expect(span.attributes).toEqual({ b: false, n: 0, s: '' });
    expect(native.spanSetAttribute).toHaveBeenCalledWith(handle, 'b', 'false');
    expect(native.spanSetAttribute).toHaveBeenCalledWith(handle, 'n', '0');
    expect(native.spanSetAttribute).toHaveBeenCalledWith(handle, 's', '""');
    expect(span.setStatus(SpanStatus.Unknown)).toBe(span);
    expect(span.status).toBe(SpanStatus.Unknown);
    expect(native.spanSetStatus).toHaveBeenCalledWith(handle, SpanStatus.Unknown);
    const childHandle = freshHandle();
    native.spanStartChild.mockReturnValue(wire({ handle: childHandle, description: null }));
    const child = span.startChildSpan('db.query');
    expect(native.spanStartChild).toHaveBeenCalledWith(handle, 'db.query', null);
    expect(child.setDescription(null)).toBe(child);
    native.spanStartChild.mockClear();
    span.startChildSpan('db.query', null);
    expect(native.spanStartChild).toHaveBeenCalledWith(handle, 'db.query', null);
    span.startChildSpan('db.query', '');
    expect(native.spanStartChild).toHaveBeenCalledWith(handle, 'db.query', '');
  });

  it('rejects attributes that are not a map of string, finite number or boolean', () => {
    expect(() => Bugsee.startTransaction('checkout', 'user.flow', null as unknown as Record<string, string>)).toThrow(
      'Bugsee.startTransaction attributes must be an object',
    );
    expect(() =>
      Bugsee.startTransaction('checkout', 'user.flow', [] as unknown as Record<string, string>),
    ).toThrow('Bugsee.startTransaction attributes must be an object');
    expect(() =>
      Bugsee.startTransaction('checkout', 'user.flow', 1 as unknown as Record<string, string>),
    ).toThrow('Bugsee.startTransaction attributes must be an object');
    const bad = 'Bugsee span attribute must be a string, a finite number or a boolean';
    expect(() => Bugsee.startTransaction('checkout', 'user.flow', { a: null as unknown as string })).toThrow(bad);
    expect(() => Bugsee.startTransaction('checkout', 'user.flow', { a: Number.NaN })).toThrow(bad);
    expect(() =>
      Bugsee.startTransaction('checkout', 'user.flow', { a: Number.POSITIVE_INFINITY }),
    ).toThrow(bad);
    expect(() => Bugsee.startTransaction('checkout', 'user.flow', { a: {} as unknown as string })).toThrow(bad);
    native.startTransaction.mockReturnValue(wire({ handle: freshHandle(), name: 'checkout', sampled: true }));
    const txn = Bugsee.startTransaction('checkout', 'user.flow', {});
    expect(native.startTransaction).toHaveBeenCalledWith('checkout', 'user.flow', jsonOf({}));
    expect(txn.attributes).toEqual({});
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle }));
    const span = Bugsee.startSpan('db.query');
    native.spanSetAttribute.mockReturnValue(true);
    span.setAttribute('keep', 'yes');
    expect(() => span.setAttribute('k', null as unknown as string)).toThrow(bad);
    expect(() => span.setAttribute('k', Number.NaN)).toThrow(bad);
    expect(() => span.setAttribute('k', Number.POSITIVE_INFINITY)).toThrow(bad);
    expect(span.attributes).toEqual({ keep: 'yes' });
    expect(native.spanSetAttribute).toHaveBeenCalledTimes(1);
  });

  it('rejects a status that is not an integer 0..5 and leaves the span open', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle, status: SpanStatus.OK }));
    const span = Bugsee.startSpan('db.query');
    const message = 'Bugsee span status must be an integer 0..5';
    expect(() => span.setStatus('1' as unknown as SpanStatus)).toThrow(TypeError);
    expect(() => span.setStatus('1' as unknown as SpanStatus)).toThrow(message);
    expect(() => span.setStatus(undefined as unknown as SpanStatus)).toThrow(TypeError);
    expect(() => span.setStatus(1.5 as unknown as SpanStatus)).toThrow(RangeError);
    expect(() => span.setStatus(1.5 as unknown as SpanStatus)).toThrow(message);
    expect(() => span.setStatus(-1 as unknown as SpanStatus)).toThrow(RangeError);
    expect(() => span.setStatus(6 as unknown as SpanStatus)).toThrow(RangeError);
    expect(() => span.setStatus(Number.NaN as unknown as SpanStatus)).toThrow(RangeError);
    expect(() => span.setStatus(Number.POSITIVE_INFINITY as unknown as SpanStatus)).toThrow(
      RangeError,
    );
    expect(() => span.finish(1.5 as unknown as SpanStatus)).toThrow(RangeError);
    expect(() => span.finish('1' as unknown as SpanStatus)).toThrow(TypeError);
    expect(native.spanSetStatus).not.toHaveBeenCalled();
    expect(native.spanFinish).not.toHaveBeenCalled();
    expect(span.finished).toBe(false);
    expect(span.status).toBe(SpanStatus.OK);
    span.setStatus(SpanStatus.OK);
    expect(native.spanSetStatus).toHaveBeenCalledWith(handle, 0);
    native.spanFinish.mockReturnValue([handle]);
    span.finish(SpanStatus.OK);
    expect(native.spanFinish).toHaveBeenCalledWith(handle, 0, true);
    expect(span.finished).toBe(true);
  });

  it('throws when native returns no span, and a missing child is a dead handle', () => {
    native.startSpan.mockReturnValue(wire({ handle: '' }));
    expect(() => Bugsee.startSpan('db.query')).toThrow('Bugsee.startSpan did not return a span');
    native.getActiveSpan.mockReturnValue(wire({ handle: 0 }));
    expect(Bugsee.getActiveSpan()).toBeNull();
    native.startTransaction.mockReturnValue(wire({ handle: '' }));
    expect(() => Bugsee.startTransaction('checkout', 'user.flow')).toThrow(
      'Bugsee.startTransaction did not return a transaction',
    );
    native.startTransaction.mockReturnValue(wire({ handle: freshHandle() }));
    expect(() => Bugsee.startTransaction('checkout', 'user.flow')).toThrow(
      'Bugsee.startTransaction did not return a transaction',
    );
    const parent = freshHandle();
    native.startTransaction.mockReturnValue(wire({ handle: parent, name: 'checkout', sampled: true }));
    const txn = Bugsee.startTransaction('checkout', 'user.flow');
    native.spanStartChild.mockReturnValue(wire({ handle: '' }));
    expect(() => txn.startChildSpan('db.query')).toThrow(expect.objectContaining(DEAD));
    expect(native.spanStartChild).toHaveBeenCalledWith(parent, 'db.query', null);
  });

  it('every later call on a finished span throws without crossing', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle }));
    native.spanFinish.mockReturnValue([handle]);
    const span = Bugsee.startSpan('db.query');
    span.finish();
    native.spanSetName.mockClear();
    native.spanSetDescription.mockClear();
    native.spanSetAttribute.mockClear();
    native.spanSetStatus.mockClear();
    native.spanStartChild.mockClear();
    native.spanFinish.mockClear();
    expect(() => span.setName('x')).toThrow(expect.objectContaining(DEAD));
    expect(() => span.setDescription('x')).toThrow(expect.objectContaining(DEAD));
    expect(() => span.setAttribute('k', 'v')).toThrow(expect.objectContaining(DEAD));
    expect(() => span.setStatus(SpanStatus.Error)).toThrow(expect.objectContaining(DEAD));
    expect(() => span.startChildSpan('op')).toThrow(expect.objectContaining(DEAD));
    expect(() => span.finish()).toThrow(expect.objectContaining(DEAD));
    expect(native.spanSetName).not.toHaveBeenCalled();
    expect(native.spanSetDescription).not.toHaveBeenCalled();
    expect(native.spanSetAttribute).not.toHaveBeenCalled();
    expect(native.spanSetStatus).not.toHaveBeenCalled();
    expect(native.spanStartChild).not.toHaveBeenCalled();
    expect(native.spanFinish).not.toHaveBeenCalled();
  });

  it('releases only the finished handle, and a later start with that handle is a new span', () => {
    const kept = freshHandle();
    const done = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle: kept, spanId: 'kept' }));
    const liveSpan = Bugsee.startSpan('db.query');
    native.startSpan.mockReturnValue(wire({ handle: done, spanId: 'done' }));
    const finished = Bugsee.startSpan('db.query');
    native.spanFinish.mockReturnValue([done, 'sp-missing']);
    expect(() => finished.finish()).not.toThrow();
    expect(finished.finished).toBe(true);
    expect(liveSpan.finished).toBe(false);
    liveSpan.setName('still');
    expect(native.spanSetName).toHaveBeenCalledWith(kept, 'still');
    native.startSpan.mockReturnValue(wire({ handle: done, spanId: 'again' }));
    const again = Bugsee.startSpan('db.query');
    expect(again).not.toBe(finished);
    expect(again.finished).toBe(false);
    expect(again.spanId).toBe('again');
  });

  it('a child handle can be started again after the parent finish drops it', () => {
    const parent = freshHandle();
    const childHandle = freshHandle();
    native.startTransaction.mockReturnValue(wire({ handle: parent, name: 'checkout', sampled: true }));
    native.spanStartChild.mockReturnValue(
      wire({ handle: childHandle, spanId: 'child', operation: 'db.query' }),
    );
    const txn = Bugsee.startTransaction('checkout', 'user.flow');
    const child = txn.startChildSpan('db.query', 'users');
    native.spanFinish.mockReturnValue([parent, childHandle]);
    txn.finish();
    native.startSpan.mockReturnValue(wire({ handle: childHandle, spanId: 'reborn' }));
    const reborn = Bugsee.startSpan('db.query');
    expect(reborn).not.toBe(child);
    expect(reborn.spanId).toBe('reborn');
    expect(reborn.finished).toBe(false);
    expect(() => child.setName('nope')).toThrow(expect.objectContaining(DEAD));
  });

  it('getActiveSpan returns the same span object, twice', () => {
    const handle = freshHandle();
    native.startSpan.mockReturnValue(wire({ handle }));
    native.getActiveSpan.mockReturnValue(wire({ handle }));
    const span = Bugsee.startSpan('db.query');
    expect(Bugsee.getActiveSpan()).toBe(span);
    expect(Bugsee.getActiveSpan()).toBe(span);
  });
});
