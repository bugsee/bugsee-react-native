import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about spans, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee, { SpanStatus } from '../index';
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
    native.startSpan.mockReturnValue(wire());
    native.spanFinish.mockReturnValue([]);
    const span = Bugsee.startSpan('db.query');
    expect(() => span.finish()).not.toThrow();
    expect(span.finished).toBe(true);
    expect(() => span.finish()).toThrow(expect.objectContaining({ code: 'E_SPAN_HANDLE_DEAD' }));
    expect(native.spanFinish).toHaveBeenCalledTimes(1);
  });

  it('a lone surrogate is well-formed, and a refused attribute is not cached', () => {
    native.startSpan.mockReturnValue(wire());
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
    expect(() => Bugsee.startSpan('')).toThrow(TypeError);
    expect(() => Bugsee.startTransaction('', 'user.flow')).toThrow(TypeError);
    expect(native.startSpan).not.toHaveBeenCalled();
    expect(native.startTransaction).not.toHaveBeenCalled();
  });
});
