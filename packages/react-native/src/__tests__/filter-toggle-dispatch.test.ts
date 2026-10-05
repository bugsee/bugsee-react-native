import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../__mocks__/native';

/**
 * `setNetworkFilter(fn)` followed at once by a capture, replayed against a
 * model of the native side under React Native's codegen dispatch rule: a
 * `void` (or `Promise`) TurboModule method is queued onto the module queue;
 * any other return type runs inline on the JS thread. The capture comes from
 * a thread of the SDK's own, so it lands right after the JS call. Whether the
 * install is queued is read from the declared return type in `NativeBugsee.ts`.
 */

let native: typeof NativeMock;
let Bugsee: {
  setNetworkFilter(callback?: ((event: { url: string }) => unknown) | null): void;
  setLogFilter(callback?: ((line: string) => unknown) | null): void;
};

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../__mocks__/native'));
  Bugsee = require('../index').default;
});

function isQueued(method: string): { declared: string | undefined; queued: boolean } {
  const source = readFileSync(join(__dirname, '..', 'NativeBugsee.ts'), 'utf8');
  const declared = new RegExp(`\\b${method}\\s*\\([^)]*\\)\\s*:\\s*([^;]+);`).exec(source)?.[1]?.trim();
  return { declared, queued: declared === 'void' || declared?.startsWith('Promise') === true };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('filter toggles under codegen dispatch', () => {
  it('declares both toggles with a return value', () => {
    expect(isQueued('setNetworkFilterEnabled').declared).toBe('boolean');
    expect(isQueued('setLogFilterEnabled').declared).toBe('boolean');
  });

  it('a request started right after setNetworkFilter is filtered, not recorded raw', async () => {
    const { queued } = isQueued('setNetworkFilterEnabled');
    const moduleQueue: Array<() => void> = [];
    const recorded: string[] = [];
    let installed = false;
    native.setNetworkFilterEnabled.mockImplementation((enabled: boolean) => {
      const body = (): void => {
        installed = enabled;
      };
      if (queued) {
        moduleQueue.push(body);
      } else {
        body();
      }
      return true;
    });
    native.replyNetworkFilter.mockImplementation((_id: string, json: string | null) => {
      if (json !== null) {
        recorded.push((JSON.parse(json) as { url: string }).url);
      }
    });

    Bugsee.setNetworkFilter((event) => ({ ...event, url: 'REDACTED' }));
    // The SDK's capture thread records the request before the queue runs.
    if (installed) {
      native.emitNetworkFilterRequest({ requestId: '1', eventJson: JSON.stringify({ url: 'SECRET' }) });
    } else {
      recorded.push('SECRET');
    }
    moduleQueue.splice(0).forEach((run) => run());
    await flush();

    expect(recorded).toEqual(['REDACTED']);
  });

  it('a console line written right after setLogFilter is filtered, not captured raw', async () => {
    const { queued } = isQueued('setLogFilterEnabled');
    const moduleQueue: Array<() => void> = [];
    const recorded: string[] = [];
    let enabled = false;
    native.setLogFilterEnabled.mockImplementation((on: boolean) => {
      const body = (): void => {
        enabled = on;
      };
      if (queued) {
        moduleQueue.push(body);
      } else {
        body();
      }
      return true;
    });
    native.replyLogFilter.mockImplementation((_id: string, line: string | null) => {
      if (line !== null) {
        recorded.push(line);
      }
    });

    Bugsee.setLogFilter((line) => line.replace('SECRET', 'REDACTED'));
    if (enabled) {
      native.emitLogFilterRequest({ requestId: '1', line: 'SECRET' });
    } else {
      recorded.push('SECRET');
    }
    moduleQueue.splice(0).forEach((run) => run());
    await flush();

    expect(recorded).toEqual(['REDACTED']);
  });
});
