import {
  buildExceptionPayload,
  describeThrown,
  EXCEPTION_MAX_REASON_LENGTH,
  EXCEPTION_MAX_NAME_LENGTH,
  EXCEPTION_MAX_FIELD_LENGTH,
  EXCEPTION_MAX_FRAMES,
  ERROR_BOUNDARY_CAUSE_NAME,
  type ExceptionPayload,
} from '../payload';
import { sha1Hex } from '../sha1';
import { V8_NODE_SAMPLE, JSC_SAMPLE } from './fixtures/captured-stacks';

function noStack(error: Error): Error {
  (error as unknown as { stack: unknown }).stack = undefined;
  return error;
}

describe('describeThrown', () => {
  it('describes a string', () => {
    expect(describeThrown('oops')).toEqual({ name: 'Error', reason: 'oops' });
  });

  it('describes an object with a string message, keeping its string name', () => {
    expect(describeThrown({ message: 'm', name: 'Weird' })).toEqual({
      name: 'Weird',
      reason: 'm',
    });
  });

  it('falls back to "Error" for a missing or non-string name', () => {
    expect(describeThrown({ message: 'm' })).toEqual({ name: 'Error', reason: 'm' });
    expect(describeThrown({ message: 'm', name: 42 })).toEqual({
      name: 'Error',
      reason: 'm',
    });
  });

  it('describes primitives and objects without a string message', () => {
    expect(describeThrown(5)).toEqual({ name: 'Error', reason: 'Non-Error thrown: number' });
    expect(describeThrown(null)).toEqual({ name: 'Error', reason: 'Non-Error thrown: object' });
    expect(describeThrown(undefined)).toEqual({
      name: 'Error',
      reason: 'Non-Error thrown: undefined',
    });
    expect(describeThrown({ foo: 'bar' })).toEqual({
      name: 'Error',
      reason: 'Non-Error thrown: object',
    });
    expect(describeThrown({ message: 42 })).toEqual({
      name: 'Error',
      reason: 'Non-Error thrown: object',
    });
  });

  it('describes a function the same way as an object, since it too can carry a message', () => {
    function weirdFn(): void {
      /* no-op */
    }
    (weirdFn as unknown as { message: string }).message = 'fn-message';
    Object.defineProperty(weirdFn, 'name', { value: 'FnError' });

    expect(describeThrown(weirdFn)).toEqual({ name: 'FnError', reason: 'fn-message' });
    expect(describeThrown(function () {})).toEqual({
      name: 'Error',
      reason: 'Non-Error thrown: function',
    });
  });
});

describe('buildExceptionPayload', () => {
  it('keys serialise in the documented order', () => {
    const cause = noStack(new RangeError('inner'));
    (cause as unknown as { stack: unknown }).stack =
      'RangeError: inner\n    at bar (/b.js:3:4)';

    const error = new TypeError('outer');
    error.stack = 'TypeError: outer\n    at foo (/a.js:1:2)';
    (error as unknown as { cause: unknown }).cause = cause;

    const debugIds = new Map([['/a.js', 'id-a']]);

    const payload = buildExceptionPayload({
      error,
      platformOS: 'android',
      debugIds,
    });

    const signature = sha1Hex(
      'TypeError' + 'foo () (/a.js:1:2)' + 'RangeError' + 'bar () (/b.js:3:4)',
    );

    const expected: ExceptionPayload = {
      name: 'TypeError',
      reason: 'outer',
      frames: [
        {
          traceRaw: '    at foo (/a.js:1:2)',
          trace: 'foo () (/a.js:1:2)',
          data: { member: 'foo', source: '/a.js', line: 1, column: 2 },
          user: true,
          debug_id: 'id-a',
        },
      ],
      cause: {
        name: 'RangeError',
        reason: 'inner',
        frames: [
          {
            traceRaw: '    at bar (/b.js:3:4)',
            trace: 'bar () (/b.js:3:4)',
            data: { member: 'bar', source: '/b.js', line: 3, column: 4 },
            user: true,
          },
        ],
      },
      signature,
      platform_os: 'android',
      debug_ids: { '/a.js': 'id-a' },
    };

    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected));
  });

  it('omits cause and debug_ids entirely -- never as a key with an undefined value', () => {
    const payload = buildExceptionPayload({ error: noStack(new Error('m')), platformOS: 'ios' });

    expect('cause' in payload).toBe(false);
    expect('debug_ids' in payload).toBe(false);
  });

  it("ERROR_BOUNDARY_CAUSE_NAME is exactly 6.x's name, literally", () => {
    expect(ERROR_BOUNDARY_CAUSE_NAME).toBe('ErrorBoundary Error');
  });

  describe('name', () => {
    it("is the error's own name, and a subclass's custom name is kept", () => {
      class MyError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'MyError';
        }
      }

      expect(
        buildExceptionPayload({ error: noStack(new MyError('bad')), platformOS: 'ios' }).name,
      ).toBe('MyError');
      expect(
        buildExceptionPayload({ error: noStack(new Error('plain')), platformOS: 'ios' }).name,
      ).toBe('Error');
    });

    it('an empty or non-string name becomes "Error"', () => {
      const empty = noStack(new Error('m'));
      empty.name = '';
      expect(buildExceptionPayload({ error: empty, platformOS: 'ios' }).name).toBe('Error');

      const nonString = noStack(new Error('m'));
      (nonString as unknown as { name: unknown }).name = 42;
      expect(buildExceptionPayload({ error: nonString, platformOS: 'ios' }).name).toBe('Error');
    });

    it('a non-string or empty name on a thrown (non-Error) object becomes "Error"', () => {
      expect(
        buildExceptionPayload({ error: { message: 'm', name: 42 }, platformOS: 'ios' }).name,
      ).toBe('Error');
      expect(
        buildExceptionPayload({ error: { message: 'm', name: '' }, platformOS: 'ios' }).name,
      ).toBe('Error');
      expect(
        buildExceptionPayload({ error: { message: 'm', name: 'Custom' }, platformOS: 'ios' })
          .name,
      ).toBe('Custom');
    });
  });

  describe('reason', () => {
    it('is the message, trimmed', () => {
      const error = noStack(new Error('  spaced out  '));
      expect(buildExceptionPayload({ error, platformOS: 'ios' }).reason).toBe('spaced out');
    });

    it('a reason over 8192 units is truncated with an ellipsis, never splitting a surrogate pair', () => {
      const longAscii = 'a'.repeat(9000);
      const asciiPayload = buildExceptionPayload({
        error: noStack(new Error(longAscii)),
        platformOS: 'ios',
      });
      expect(asciiPayload.reason).toBe('a'.repeat(EXCEPTION_MAX_REASON_LENGTH) + '…');

      const prefix = 'a'.repeat(EXCEPTION_MAX_REASON_LENGTH - 1);
      const messageWithPair = prefix + '\u{1F600}' + 'tail'.repeat(10);
      const pairPayload = buildExceptionPayload({
        error: noStack(new Error(messageWithPair)),
        platformOS: 'ios',
      });
      expect(pairPayload.reason).toBe(`${prefix}…`);
    });

    it('a reason exactly 8192 units long is not truncated', () => {
      const exact = 'a'.repeat(EXCEPTION_MAX_REASON_LENGTH);
      const payload = buildExceptionPayload({
        error: noStack(new Error(exact)),
        platformOS: 'ios',
      });
      expect(payload.reason).toBe(exact);
    });

    it('backs off exactly at the surrogate-range boundaries (0xD800 and 0xDBFF)', () => {
      const prefix = 'a'.repeat(EXCEPTION_MAX_REASON_LENGTH - 1);

      const minHighSurrogatePair = String.fromCharCode(0xd800, 0xdc00);
      const minPayload = buildExceptionPayload({
        error: noStack(new Error(prefix + minHighSurrogatePair + 'tail'.repeat(10))),
        platformOS: 'ios',
      });
      expect(minPayload.reason).toBe(`${prefix}…`);

      const maxHighSurrogatePair = String.fromCharCode(0xdbff, 0xdc00);
      const maxPayload = buildExceptionPayload({
        error: noStack(new Error(prefix + maxHighSurrogatePair + 'tail'.repeat(10))),
        platformOS: 'ios',
      });
      expect(maxPayload.reason).toBe(`${prefix}…`);
    });

    it('does not back off for a code unit above the high-surrogate range', () => {
      const prefix = 'a'.repeat(EXCEPTION_MAX_REASON_LENGTH - 1);
      const notASurrogate = String.fromCharCode(0xe000);

      const payload = buildExceptionPayload({
        error: noStack(new Error(prefix + notASurrogate + 'tail'.repeat(10))),
        platformOS: 'ios',
      });

      // The cut lands right after the extra character -- no back-off, and the
      // character itself is kept (not split, since it never needed to be).
      expect(payload.reason).toBe(`${prefix}${notASurrogate}…`);
    });
  });

  describe('frames', () => {
    it('come from the stack, top first', () => {
      const error = new Error('m');
      error.stack = 'Error: m\n    at first (/a.js:1:1)\n    at second (/b.js:2:2)';
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });
      expect(payload.frames.map((f) => f.data.member)).toEqual(['first', 'second']);
    });

    it("a frame's trace is \"member () (source:line:column)\" and its data carries member, source, line and column", () => {
      const error = new Error('m');
      error.stack = 'Error: m\n    at doThing (/x/y.js:5:9)';
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames[0]).toEqual({
        traceRaw: '    at doThing (/x/y.js:5:9)',
        trace: 'doThing () (/x/y.js:5:9)',
        data: { member: 'doThing', source: '/x/y.js', line: 5, column: 9 },
        user: true,
      });
    });

    it('a node_modules frame, or one with no location at all, is not user', () => {
      const error = new Error('m');
      error.stack = [
        'Error: m',
        '    at fn1 (/app/node_modules/pkg/index.js:1:1)',
        '    at forEach (native)',
      ].join('\n');
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames[0]?.user).toBe(false);
      expect(payload.frames[1]?.user).toBeUndefined();
    });

    it('a frame with a file but no line number is not user, and its trace omits the location', () => {
      const error = new Error('m');
      error.stack = 'Error: m\n    at foo (/a.js)';
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames[0]).toEqual({
        traceRaw: '    at foo (/a.js)',
        trace: 'foo () (/a.js)',
        data: { member: 'foo', source: '/a.js', line: null, column: null },
        user: false,
      });
    });

    it("a frame with no member name gets '<unknown>'", () => {
      const error = new Error('m');
      error.stack = 'Error: m\napp.bundle:1:2';
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames[0]?.data.member).toBe('<unknown>');
      expect(payload.frames[0]?.trace).toBe('<unknown> () (app.bundle:1:2)');
    });

    it("a frame whose source contains 'native code' or '(native)' is not user", () => {
      const error = new Error('m');
      error.stack = [
        'Error: m',
        'fn1@/app/native code/bundle.js:3:3',
        'fn2@/app/(native)/bundle.js:4:4',
      ].join('\n');
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames[0]?.user).toBe(false);
      expect(payload.frames[1]?.user).toBe(false);
    });

    it('frames beyond 256 are dropped', () => {
      const lines = ['Error: m'];
      for (let i = 0; i < 300; i += 1) {
        lines.push(`    at fn${i} (/a.js:${i}:1)`);
      }
      const error = new Error('m');
      error.stack = lines.join('\n');
      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.frames).toHaveLength(256);
      expect(payload.frames[0]?.data.member).toBe('fn0');
      expect(payload.frames[255]?.data.member).toBe('fn255');
    });

    it("a frame's debug_id is set when its file key is in the map, and omitted otherwise", () => {
      const error = new Error('m');
      error.stack = [
        'Error: m',
        '    at known (address at index.android.bundle:1:2)',
        '    at unknown (/other.js:3:4)',
      ].join('\n');
      const debugIds = new Map([['index.android.bundle', 'id-123']]);
      const payload = buildExceptionPayload({ error, platformOS: 'android', debugIds });

      expect(payload.frames[0]?.debug_id).toBe('id-123');
      expect('debug_id' in (payload.frames[1] as object)).toBe(false);
      expect(payload.debug_ids).toEqual({ 'index.android.bundle': 'id-123' });
    });

    it('omits debug_ids entirely when the map is empty or absent', () => {
      const error = noStack(new Error('m'));
      expect(buildExceptionPayload({ error, platformOS: 'ios' }).debug_ids).toBeUndefined();
      expect(
        buildExceptionPayload({ error, platformOS: 'ios', debugIds: new Map() }).debug_ids,
      ).toBeUndefined();
    });
  });

  describe('cause chain', () => {
    it('nests, and stops at depth 10', () => {
      const chainLength = 12;
      const errors = Array.from({ length: chainLength }, (_, i) => {
        const error = noStack(new Error(`msg${i}`));
        error.name = `E${i}`;
        return error;
      });
      for (let i = 0; i < chainLength - 1; i += 1) {
        (errors[i] as unknown as { cause: unknown }).cause = errors[i + 1];
      }

      const payload = buildExceptionPayload({ error: errors[0], platformOS: 'ios' });

      const names: string[] = [];
      let node: ExceptionPayload['cause'] | ExceptionPayload = payload;
      while (node) {
        names.push(node.name);
        node = node.cause;
      }

      expect(names).toEqual([
        'E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10',
      ]);
    });

    it('stops at a repeat', () => {
      const a = noStack(new Error('a-msg'));
      a.name = 'A';
      const b = noStack(new Error('b-msg'));
      b.name = 'B';
      (a as unknown as { cause: unknown }).cause = b;
      (b as unknown as { cause: unknown }).cause = a;

      const payload = buildExceptionPayload({ error: a, platformOS: 'ios' });

      expect(payload.name).toBe('A');
      expect(payload.cause?.name).toBe('B');
      expect(payload.cause?.cause).toBeUndefined();
    });

    it('stops at a repeat of a non-root, intermediate node (not just the root)', () => {
      const a = noStack(new Error('a-msg'));
      a.name = 'A';
      const b = noStack(new Error('b-msg'));
      b.name = 'B';
      const c = noStack(new Error('c-msg'));
      c.name = 'C';
      (a as unknown as { cause: unknown }).cause = b;
      (b as unknown as { cause: unknown }).cause = c;
      (c as unknown as { cause: unknown }).cause = b;

      const payload = buildExceptionPayload({ error: a, platformOS: 'ios' });

      expect(payload.name).toBe('A');
      expect(payload.cause?.name).toBe('B');
      expect(payload.cause?.cause?.name).toBe('C');
      expect(payload.cause?.cause?.cause).toBeUndefined();
    });

    it('a cause that is not an Error is described, never serialised', () => {
      const error = noStack(new Error('top'));
      (error as unknown as { cause: unknown }).cause = {
        password: 'secret',
        message: 'inner-msg',
      };

      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.cause).toEqual({ name: 'Error', reason: 'inner-msg', frames: [] });
      expect(JSON.stringify(payload)).not.toContain('secret');
    });

    it('a primitive (non-object) cause is described too, and never breaks cycle tracking', () => {
      const stringCause = noStack(new Error('top'));
      (stringCause as unknown as { cause: unknown }).cause = 'a plain string cause';
      expect(buildExceptionPayload({ error: stringCause, platformOS: 'ios' }).cause).toEqual({
        name: 'Error',
        reason: 'a plain string cause',
        frames: [],
      });

      const numberCause = noStack(new Error('top'));
      (numberCause as unknown as { cause: unknown }).cause = 42;
      expect(buildExceptionPayload({ error: numberCause, platformOS: 'ios' }).cause).toEqual({
        name: 'Error',
        reason: 'Non-Error thrown: number',
        frames: [],
      });

      const nullCause = noStack(new Error('top'));
      (nullCause as unknown as { cause: unknown }).cause = null;
      expect(buildExceptionPayload({ error: nullCause, platformOS: 'ios' }).cause).toEqual({
        name: 'Error',
        reason: 'Non-Error thrown: object',
        frames: [],
      });
    });
  });

  describe('a Proxy target', () => {
    it('no property other than name, message, stack and cause is read', () => {
      const real = noStack(new Error('boom'));
      real.name = 'Boom';
      (real as unknown as { cause: unknown }).cause = undefined;

      const seenProps = new Set<string>();
      const proxy = new Proxy(real, {
        get(target, prop, receiver) {
          if (typeof prop === 'string') {
            seenProps.add(prop);
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      buildExceptionPayload({ error: proxy, platformOS: 'ios' });

      expect([...seenProps].sort()).toEqual(['cause', 'message', 'name', 'stack']);
    });

    it('a thrown object gives its string message and name and nothing else', () => {
      const seenProps: string[] = [];
      const target = { password: 'pw', message: 'm' };
      const proxy = new Proxy(target, {
        get(t, prop, receiver) {
          if (typeof prop === 'string') {
            seenProps.push(prop);
          }
          return Reflect.get(t, prop, receiver);
        },
      });

      const payload = buildExceptionPayload({ error: proxy, platformOS: 'ios' });

      expect(payload.reason).toBe('m');
      expect(payload.name).toBe('Error');
      expect(seenProps).toEqual(['message', 'name']);
      expect(JSON.stringify(payload)).not.toContain('pw');
    });
  });

  describe('a thrown non-Error value', () => {
    it('a thrown string is the reason and has no frames', () => {
      const payload = buildExceptionPayload({ error: 'boom', platformOS: 'ios' });
      expect(payload.name).toBe('Error');
      expect(payload.reason).toBe('boom');
      expect(payload.frames).toEqual([]);
    });

    it('a thrown number, null or undefined is "Non-Error thrown: <typeof>"', () => {
      expect(buildExceptionPayload({ error: 42, platformOS: 'ios' }).reason).toBe(
        'Non-Error thrown: number',
      );
      expect(buildExceptionPayload({ error: null, platformOS: 'ios' }).reason).toBe(
        'Non-Error thrown: object',
      );
      expect(buildExceptionPayload({ error: undefined, platformOS: 'ios' }).reason).toBe(
        'Non-Error thrown: undefined',
      );
    });

    it('a non-Error uses fallbackStack for its frames', () => {
      const payload = buildExceptionPayload({
        error: 'boom',
        platformOS: 'ios',
        fallbackStack: '    at foo (/a.js:1:2)',
      });

      expect(payload.frames).toEqual([
        {
          traceRaw: '    at foo (/a.js:1:2)',
          trace: 'foo () (/a.js:1:2)',
          data: { member: 'foo', source: '/a.js', line: 1, column: 2 },
          user: true,
        },
      ]);
    });

    it('an Error ignores fallbackStack', () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at real (/real.js:9:9)';

      const payload = buildExceptionPayload({
        error,
        platformOS: 'ios',
        fallbackStack: '    at fake (/fake.js:1:1)',
      });

      expect(payload.frames).toHaveLength(1);
      expect(payload.frames[0]?.data.source).toBe('/real.js');
    });
  });

  describe('componentStack (R10)', () => {
    it('becomes the innermost cause, named "ErrorBoundary Error"', () => {
      const error = noStack(new Error('boom'));

      const payload = buildExceptionPayload({
        error,
        platformOS: 'ios',
        componentStack: '    in MyComponent (at App.js:10)\n    in Root (at index.js:1)',
      });

      expect(payload.cause).toEqual({
        name: ERROR_BOUNDARY_CAUSE_NAME,
        reason: '',
        frames: [
          {
            traceRaw: '    in MyComponent (at App.js:10)',
            trace: 'MyComponent () (App.js:10)',
            data: { member: 'MyComponent', source: 'App.js', line: 10, column: null },
            user: false,
          },
          {
            traceRaw: '    in Root (at index.js:1)',
            trace: 'Root () (index.js:1)',
            data: { member: 'Root', source: 'index.js', line: 1, column: null },
            user: false,
          },
        ],
      });
    });

    it("is appended below the error's own cause, which is not changed", () => {
      const inner = noStack(new Error('inner'));
      const error = noStack(new Error('outer'));
      (error as unknown as { cause: unknown }).cause = inner;

      const payload = buildExceptionPayload({
        error,
        platformOS: 'ios',
        componentStack: '    in X (at F.js:1)',
      });

      expect(payload.cause).toMatchObject({ name: 'Error', reason: 'inner' });
      expect(payload.cause?.cause).toEqual({
        name: ERROR_BOUNDARY_CAUSE_NAME,
        reason: '',
        frames: [
          {
            traceRaw: '    in X (at F.js:1)',
            trace: 'X () (F.js:1)',
            data: { member: 'X', source: 'F.js', line: 1, column: null },
            user: false,
          },
        ],
      });

      // The original error's own cause chain was never mutated.
      expect((inner as unknown as { cause: unknown }).cause).toBeUndefined();
    });
  });

  describe('signature', () => {
    it("is sha1 of the chain's names and traces", () => {
      const error = new Error('boom');
      error.name = 'Boom';
      error.stack = 'Boom: boom\n    at foo (/a.js:1:2)';

      const payload = buildExceptionPayload({ error, platformOS: 'ios' });

      expect(payload.signature).toBe(sha1Hex('Boom' + 'foo () (/a.js:1:2)'));
    });

    it('does not change with the reason', () => {
      const first = new Error('message one');
      first.name = 'Boom';
      first.stack = 'Boom: message one\n    at foo (/a.js:1:2)';

      const second = new Error('a very different message');
      second.name = 'Boom';
      second.stack = 'Boom: whatever\n    at foo (/a.js:1:2)';

      const firstPayload = buildExceptionPayload({ error: first, platformOS: 'ios' });
      const secondPayload = buildExceptionPayload({ error: second, platformOS: 'ios' });

      expect(firstPayload.reason).not.toBe(secondPayload.reason);
      expect(firstPayload.signature).toBe(secondPayload.signature);
    });
  });

  describe('platform_os', () => {
    it('is the one given', () => {
      const error = noStack(new Error('m'));
      expect(buildExceptionPayload({ error, platformOS: 'android' }).platform_os).toBe(
        'android',
      );
      expect(buildExceptionPayload({ error, platformOS: 'ios' }).platform_os).toBe('ios');
    });
  });

  describe('hostile getters', () => {
    it('a throwing getter is treated as absent', () => {
      const nameThrows = new Error('safe message');
      Object.defineProperty(nameThrows, 'name', {
        get(): string {
          throw new Error('boom-name');
        },
      });
      const nameThrowsPayload = buildExceptionPayload({ error: nameThrows, platformOS: 'ios' });
      expect(nameThrowsPayload.name).toBe('Error');
      expect(nameThrowsPayload.reason).toBe('safe message');

      const stackThrows = new Error('m');
      Object.defineProperty(stackThrows, 'stack', {
        get(): string {
          throw new Error('boom-stack');
        },
      });
      expect(buildExceptionPayload({ error: stackThrows, platformOS: 'ios' }).frames).toEqual(
        [],
      );

      const causeThrows = noStack(new Error('m'));
      Object.defineProperty(causeThrows, 'cause', {
        get(): unknown {
          throw new Error('boom-cause');
        },
      });
      expect(
        buildExceptionPayload({ error: causeThrows, platformOS: 'ios' }).cause,
      ).toBeUndefined();

      const messageThrows = Object.create(Error.prototype) as Error;
      Object.defineProperty(messageThrows, 'message', {
        get(): string {
          throw new Error('boom-message');
        },
      });
      Object.defineProperty(messageThrows, 'name', { value: 'Weird' });
      const messageThrowsPayload = buildExceptionPayload({
        error: messageThrows,
        platformOS: 'ios',
      });
      expect(messageThrowsPayload.name).toBe('Weird');
      expect(messageThrowsPayload.reason).toBe('');
    });

    it("never throws even when the builder's own input cannot be read (a revoked Proxy)", () => {
      const revocable = Proxy.revocable<{ error: unknown; platformOS: 'ios' }>(
        { error: new Error('x'), platformOS: 'ios' },
        {},
      );
      revocable.revoke();

      let payload: ExceptionPayload | undefined;
      expect(() => {
        payload = buildExceptionPayload(revocable.proxy);
      }).not.toThrow();

      expect(payload?.name).toBe('Error');
      expect(payload?.reason).toBe('Non-Error thrown: object');
      expect(payload?.frames).toEqual([]);
      expect(payload?.signature).toMatch(/^[0-9a-f]{40}$/);
      expect(payload?.platform_os).toBe('ios');
    });

    it('the error value itself is unreadable (a revoked Proxy) -- instanceof and property reads both fail safe', () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();

      let payload: ExceptionPayload | undefined;
      expect(() => {
        payload = buildExceptionPayload({ error: revocable.proxy, platformOS: 'ios' });
      }).not.toThrow();

      expect(payload).toEqual({
        name: 'Error',
        reason: 'Non-Error thrown: object',
        frames: [],
        signature: sha1Hex('Error'),
        platform_os: 'ios',
      });
    });

    it("recovers the real platformOS when only reading .error fails, exercising buildFallbackPayload's own try", () => {
      const target = { error: new Error('x'), platformOS: 'android' as const };
      const trickyInput = new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'error') {
            throw new Error('boom-input-error');
          }
          return Reflect.get(t, prop, receiver);
        },
      });

      let payload: ExceptionPayload | undefined;
      expect(() => {
        payload = buildExceptionPayload(trickyInput);
      }).not.toThrow();

      expect(payload).toEqual({
        name: 'Error',
        reason: 'Non-Error thrown: object',
        frames: [],
        signature: sha1Hex('Error'),
        platform_os: 'android',
      });
    });

    it("recovers 'ios' too, so the check is not just the left side of the OR", () => {
      const target = { error: new Error('x'), platformOS: 'ios' as const };
      const trickyInput = new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'error') {
            throw new Error('boom-input-error');
          }
          return Reflect.get(t, prop, receiver);
        },
      });

      const payload = buildExceptionPayload(trickyInput);

      expect(payload.platform_os).toBe('ios');
    });
  });
});

describe('field length caps (review I1)', () => {
  it('truncates a long name to EXCEPTION_MAX_NAME_LENGTH', () => {
    const error = noStack(new Error('m'));
    error.name = 'N'.repeat(EXCEPTION_MAX_NAME_LENGTH + 500);

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.name.length).toBe(EXCEPTION_MAX_NAME_LENGTH + 1);
    expect(payload.name.endsWith('…')).toBe(true);
  });

  it('truncates a long file (source and traceRaw) to EXCEPTION_MAX_FIELD_LENGTH', () => {
    const hugeFile = `/${'a'.repeat(EXCEPTION_MAX_FIELD_LENGTH + 500)}`;
    const error = new Error('m');
    error.stack = `Error: m\n    at fn (${hugeFile}:1:2)`;

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });
    const frame = payload.frames[0];

    expect(frame?.data.source.length).toBe(EXCEPTION_MAX_FIELD_LENGTH + 1);
    expect(frame?.data.source.endsWith('…')).toBe(true);
    expect(frame?.traceRaw.length).toBeLessThanOrEqual(EXCEPTION_MAX_FIELD_LENGTH + 1);
  });

  it('truncates a long member name to EXCEPTION_MAX_FIELD_LENGTH', () => {
    const hugeMember = 'm'.repeat(EXCEPTION_MAX_FIELD_LENGTH + 500);
    const error = new Error('m');
    error.stack = `Error: m\n    at ${hugeMember} (/a.js:1:2)`;

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });
    const frame = payload.frames[0];

    expect(frame?.data.member.length).toBe(EXCEPTION_MAX_FIELD_LENGTH + 1);
    expect(frame?.data.member.endsWith('…')).toBe(true);
  });

  it('bounds the total payload size for a hostile stack (the review measured 76.8 MB before this fix)', () => {
    const hugeFile = 'x'.repeat(2000); // under STACK_MAX_LINE_LENGTH, over EXCEPTION_MAX_FIELD_LENGTH
    const lines = ['Error: m'];
    for (let i = 0; i < 300; i += 1) {
      lines.push(`    at fn (${hugeFile}:1)`);
    }
    const error = new Error('m');
    error.stack = lines.join('\n');

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames.length).toBeLessThanOrEqual(EXCEPTION_MAX_FRAMES);
    expect(JSON.stringify(payload).length).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('the "Name: message" header is stripped before parsing, not just skipped (review I2)', () => {
  it('a header shaped like "Error: connect ECONNREFUSED 10.0.0.1:5432" never becomes a frame', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    error.stack = 'Error: connect ECONNREFUSED 10.0.0.1:5432';

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toEqual([]);
  });

  it('a Hermes-shaped header ending in "host:5432" never becomes a frame; the real frame after it still parses', () => {
    const error = new Error('failed talking to host.example.com:5432');
    error.stack = [
      'Error: failed talking to host.example.com:5432',
      '    at real (real.js:1:1)',
    ].join('\n');

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]?.data.member).toBe('real');
  });

  it('a multi-line message with a frame-looking second line never becomes a frame', () => {
    const message = 'line one\n  more detail at host.example.com:8443';
    const error = new Error(message);
    error.stack = [`Error: ${message}`, '    at real (real.js:1:1)'].join('\n');

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]?.data.member).toBe('real');
  });

  it('an empty message strips just the bare name header', () => {
    const error = new Error('');
    error.stack = ['Error', '    at real (real.js:1:1)'].join('\n');

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0]?.data.member).toBe('real');
  });

  it('a JSC-shaped stack with no header is left untouched -- the strip is conditional', () => {
    const error = new Error('m');
    error.stack = 'global@app.bundle:1:2'; // JSC never prepends "Name: message"

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toEqual([
      {
        traceRaw: 'global@app.bundle:1:2',
        trace: 'global () (app.bundle:1:2)',
        data: { member: 'global', source: 'app.bundle', line: 1, column: 2 },
        user: true,
      },
    ]);
  });

  it('the signature does not change with a message that differs only in a frame-shaped token', () => {
    const stackFor = (message: string): string =>
      [`Error: ${message}`, '    at real (real.js:1:1)'].join('\n');

    const first = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    first.stack = stackFor('connect ECONNREFUSED 10.0.0.1:5432');

    const second = new Error('connect ECONNREFUSED 10.0.0.2:5432');
    second.stack = stackFor('connect ECONNREFUSED 10.0.0.2:5432');

    const firstPayload = buildExceptionPayload({ error: first, platformOS: 'ios' });
    const secondPayload = buildExceptionPayload({ error: second, platformOS: 'ios' });

    expect(firstPayload.reason).not.toBe(secondPayload.reason);
    expect(firstPayload.frames).toEqual(secondPayload.frames);
    expect(firstPayload.signature).toBe(secondPayload.signature);
  });
});

describe('real captured stacks, end to end (review M2)', () => {
  it('a real V8 stack has its "Error: message" header stripped and all ten frames parsed', () => {
    const error = new Error('captured stack sample');
    error.stack = V8_NODE_SAMPLE; // already includes the real "Error: ..." header line

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toHaveLength(10);
    expect(payload.frames[0]?.data.member).toBe('level3');
    expect(payload.frames.some((f) => f.traceRaw.includes('captured stack sample'))).toBe(false);
  });

  it('a real JSC stack (no header to strip) parses its five frames', () => {
    const error = new Error('captured stack sample');
    error.stack = JSC_SAMPLE; // JSC never prepends "Name: message"

    const payload = buildExceptionPayload({ error, platformOS: 'ios' });

    expect(payload.frames).toHaveLength(5);
    expect(payload.frames[4]?.data.member).toBe('global code');
  });
});
