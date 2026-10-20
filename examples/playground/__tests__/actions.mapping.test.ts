import Bugsee from '@bugsee/react-native';
import * as Feedback from '@bugsee/react-native-feedback';
import { PlaygroundNative } from '../modules/playground-native';
import { ALL_ACTIONS } from '../src/screens/allActions';
import { reportsActions, resetReportsState } from '../src/screens/ReportsScreen';
import { callTarget } from '../src/ui/action';
import type { Action } from '../src/ui/action';

jest.useFakeTimers();

/** Actions that cannot be verified in jest, with the reason. Deliberately empty: every action is checked. */
const EXEMPT: Record<string, string> = {};

const ids = ALL_ACTIONS.map((a) => `${a.screen}/${a.action.id}`);
test('ids are unique', () => expect(new Set(ids).size).toBe(ids.length));
test('EXEMPT entries name real actions', () => {
  for (const id of Object.keys(EXEMPT)) expect(ids).toContain(id);
});

type Fn = jest.Mock;
const mocks = {
  Bugsee: Bugsee as unknown as Record<string, Fn>,
  Feedback: Feedback as unknown as Record<string, Fn>,
  PlaygroundNative: PlaygroundNative as unknown as Record<string, Fn>,
};
const appearances: Record<string, Record<string, unknown>> = {
  Bugsee: (Bugsee as unknown as { appearance: Record<string, unknown> }).appearance,
  Feedback: (Feedback as unknown as { appearance: Record<string, unknown> }).appearance,
};

const swallow = async (fn: () => unknown) => {
  try {
    await Promise.resolve(fn());
  } catch {
    // Rejections are logged by ActionButton; the call made is what these tests check.
  }
};
/**
 * Starts the action without awaiting it (fake timers would deadlock sleeps), drives every timer, including the
 * afterTap ones, then settles the action. Deliberate throws and rejections are tolerated.
 */
const runAndFlush = async (action: Action) => {
  let pending: unknown;
  try {
    pending = Promise.resolve(action.run());
    (pending as Promise<unknown>).catch(() => {}); // handled up front: a timer may reject it mid-flush
  } catch {
    // A synchronous throw is a deliberate crash.
  }
  await swallow(() => jest.runAllTimersAsync());
  await swallow(() => pending);
};

class FakeXhr {
  static made = jest.fn();
  status = 200;
  onload: (() => void) | null = null;
  constructor() {
    FakeXhr.made();
  }
  open = jest.fn();
  send = jest.fn(() => this.onload?.());
}
class FakeWebSocket {
  static made = jest.fn();
  constructor() {
    FakeWebSocket.made();
  }
  send = jest.fn();
  close = jest.fn();
}

const originals = { fetch: global.fetch, xhr: global.XMLHttpRequest, ws: global.WebSocket };
afterAll(() => {
  global.fetch = originals.fetch;
  global.XMLHttpRequest = originals.xhr;
  global.WebSocket = originals.ws;
});

beforeEach(() => {
  jest.clearAllMocks();
  resetReportsState();
  for (const a of Object.values(appearances)) for (const k of Object.keys(a)) delete a[k];
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  global.XMLHttpRequest = FakeXhr as never;
  global.WebSocket = FakeWebSocket as never;
});

const createAction = reportsActions.find((a) => a.id === 'created-create') as Action;

describe.each(ALL_ACTIONS.map((a) => [`${a.screen}/${a.action.id}`, a.action] as const))('%s', (id, action) => {
  const target = callTarget(action.call);
  const name = `${target.object}.${target.member}`;
  const skip = id in EXEMPT ? test.skip : test;

  skip(`runs ${name}`, async () => {
    switch (target.object) {
      case 'Bugsee':
      case 'Feedback':
      case 'PlaygroundNative': {
        if (target.member === 'appearance') {
          const obj = appearances[target.object];
          await runAndFlush(action);
          const values = Object.values(obj);
          expect(values.length).toBeGreaterThan(0);
          // The call string names the value it assigns; at least one assigned property must be that value.
          expect(values.some((v) => action.call.includes(String(v)))).toBe(true);
          return;
        }
        const fn = mocks[target.object][target.member];
        expect(jest.isMockFunction(fn)).toBe(true);
        await runAndFlush(action);
        expect(fn).toHaveBeenCalled();
        return;
      }
      case 'console': {
        const spy = jest.spyOn(console, target.member as 'log').mockImplementation(() => {});
        await runAndFlush(action);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
        return;
      }
      case 'report': {
        await createAction.run();
        const report = await (mocks.Bugsee.createReport.mock.results[0].value as Promise<Record<string, Fn>>);
        await runAndFlush(action);
        expect(report[target.member]).toHaveBeenCalled();
        return;
      }
      case 'global': {
        if (target.member === 'Promise') {
          // An unhandled rejection cannot be observed reliably inside jest (the runner owns that hook), so
          // intercept Promise.reject: the action must start a rejection, and must not throw synchronously.
          const realReject = Promise.reject.bind(Promise);
          const reject = jest.spyOn(Promise, 'reject').mockImplementation((e) => {
            const p = realReject(e);
            p.catch(() => {}); // keep the test process alive; the call itself is what is asserted
            return p;
          });
          expect(() => action.run()).not.toThrow();
          expect(reject).toHaveBeenCalledWith(expect.any(Error));
          reject.mockRestore();
          await swallow(async () => {});
          return;
        }
        await runAndFlush(action);
        const seen = { fetch: global.fetch, XMLHttpRequest: FakeXhr.made, WebSocket: FakeWebSocket.made }[
          target.member as 'fetch' | 'XMLHttpRequest' | 'WebSocket'
        ];
        expect(seen).toHaveBeenCalled();
        return;
      }
    }
  });
});
