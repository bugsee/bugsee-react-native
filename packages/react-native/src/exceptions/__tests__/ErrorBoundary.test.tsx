/**
 * `<ErrorBoundary>` reports a caught render error as handled and renders a
 * fallback. `reportHandled` / `markReported` are mocked so a failure here is
 * about the boundary's own wiring, not the report path.
 */
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';

import type * as ReportModule from '../report';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

const reportHandled = jest.fn();
const markReported = jest.fn(() => true);

jest.mock('../report', () => {
  const actual = jest.requireActual('../report') as typeof ReportModule;
  return {
    ...actual,
    get reportHandled() {
      return reportHandled;
    },
    get markReported() {
      return markReported;
    },
  };
});

import {
  ErrorBoundary,
  type ErrorBoundaryFallbackProps,
} from '../ErrorBoundary';

(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: ReactTestRenderer[] = [];
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  markReported.mockImplementation(() => true);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => mounted.forEach((renderer) => renderer.unmount()));
  mounted = [];
  consoleError.mockRestore();
});

function render(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock: () => ({}),
      unstable_isConcurrent: true,
    } as Parameters<typeof create>[1]);
  });
  mounted.push(renderer as ReactTestRenderer);
  return renderer as ReactTestRenderer;
}

function ThrowOnce({ error, armed }: { error: unknown; armed: { value: boolean } }): ReactElement {
  if (armed.value) {
    throw error;
  }
  return createElement('child-ok');
}

describe('ErrorBoundary', () => {
  it('a render error below it is reported as handled, with its component stack', () => {
    const error = new Error('boundary-boom');
    render(
      <ErrorBoundary>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(markReported).toHaveBeenCalledWith(error);
    expect(reportHandled).toHaveBeenCalledTimes(1);
    expect(reportHandled).toHaveBeenCalledWith(
      error,
      undefined,
      expect.objectContaining({
        componentStack: expect.stringContaining('ThrowOnce'),
      }),
    );
  });

  it('renders the fallback element', () => {
    const error = new Error('boom');
    const renderer = render(
      <ErrorBoundary fallback={createElement('fallback-el')}>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(renderer.root.findByType('fallback-el' as never)).toBeTruthy();
  });

  it('calls a fallback function with the error, the component stack and resetError', () => {
    const error = new Error('boom');
    let received: ErrorBoundaryFallbackProps | undefined;
    render(
      <ErrorBoundary
        fallback={(props: ErrorBoundaryFallbackProps) => {
          received = props;
          return createElement('fallback-fn');
        }}
      >
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(received).toBeDefined();
    expect(received!.error).toBe(error);
    expect(typeof received!.componentStack).toBe('string');
    expect(received!.componentStack).toContain('ThrowOnce');
    expect(typeof received!.resetError).toBe('function');
  });

  it('renders null without a fallback', () => {
    const error = new Error('boom');
    const renderer = render(
      <ErrorBoundary>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(renderer.toJSON()).toBeNull();
    // Distinguishes `return null` from falling through to `return fallback`
    // when fallback is undefined (both look like null in toJSON alone).
    expect(renderer.root.findAllByType('child-ok' as never)).toHaveLength(0);
    expect(() => renderer.root.findByType(ErrorBoundary as never)).not.toThrow();
  });

  it('onError gets the error and the component stack', () => {
    const error = new Error('boom');
    const onError = jest.fn();
    render(
      <ErrorBoundary onError={onError}>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(error);
    expect(onError.mock.calls[0]![1]).toEqual(expect.stringContaining('ThrowOnce'));
  });

  it('resetError calls onReset and renders the children again', () => {
    const error = new Error('boom');
    const onReset = jest.fn();
    const armed = { value: true };
    let resetError: (() => void) | undefined;

    const renderer = render(
      <ErrorBoundary
        onReset={onReset}
        fallback={(props: ErrorBoundaryFallbackProps) => {
          resetError = props.resetError;
          return createElement('fallback-el');
        }}
      >
        <ThrowOnce error={error} armed={armed} />
      </ErrorBoundary>,
    );

    expect(renderer.root.findByType('fallback-el' as never)).toBeTruthy();
    armed.value = false;
    act(() => {
      resetError!();
    });

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset.mock.calls[0]![0]).toBe(error);
    expect(onReset.mock.calls[0]![1]).toEqual(expect.stringContaining('ThrowOnce'));
    expect(renderer.root.findByType('child-ok' as never)).toBeTruthy();
  });

  it('resetError without onReset still restores the children', () => {
    const error = new Error('boom');
    const armed = { value: true };
    let resetError: (() => void) | undefined;

    const renderer = render(
      <ErrorBoundary
        fallback={(props: ErrorBoundaryFallbackProps) => {
          resetError = props.resetError;
          return createElement('fallback-el');
        }}
      >
        <ThrowOnce error={error} armed={armed} />
      </ErrorBoundary>,
    );

    armed.value = false;
    expect(() => {
      act(() => {
        resetError!();
      });
    }).not.toThrow();
    expect(renderer.root.findByType('child-ok' as never)).toBeTruthy();
  });

  it('the caught error is not mutated', () => {
    const cause = new Error('original-cause');
    const error = new Error('boom');
    (error as Error & { cause: unknown }).cause = cause;

    render(
      <ErrorBoundary>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect((error as Error & { cause: unknown }).cause).toBe(cause);
  });

  it('options reach the report', () => {
    const error = new Error('boom');
    const options = { domain: 'auth', labels: ['a'] as const };
    render(
      <ErrorBoundary options={options}>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(reportHandled).toHaveBeenCalledWith(
      error,
      options,
      expect.objectContaining({
        componentStack: expect.stringContaining('ThrowOnce'),
      }),
    );
  });

  it('rejects bad options before claiming, and still reports the error', () => {
    const error = new Error('boom');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <ErrorBoundary options={{ domain: '' }}>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(warn).toHaveBeenCalledWith(
      '[Bugsee] ErrorBoundary options rejected; reporting without options',
      'RangeError',
    );
    expect(markReported).toHaveBeenCalledWith(error);
    expect(reportHandled).toHaveBeenCalledWith(
      error,
      undefined,
      expect.objectContaining({
        componentStack: expect.stringContaining('ThrowOnce'),
      }),
    );
    warn.mockRestore();
  });

  it('an error reported once is not reported again by the boundary', () => {
    const error = new Error('already');
    markReported.mockReturnValueOnce(false);

    render(
      <ErrorBoundary>
        <ThrowOnce error={error} armed={{ value: true }} />
      </ErrorBoundary>,
    );

    expect(markReported).toHaveBeenCalledWith(error);
    expect(reportHandled).not.toHaveBeenCalled();
  });
});
