import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import type { native as NativeMock } from '../../__mocks__/native';

/**
 * The same-turn sequence of the breadcrumb-filter e2e scenario, replayed
 * against a model of each native bridge under React Native's codegen
 * dispatch rule: a `void` (or `Promise`) TurboModule method is queued onto
 * the module queue (iOS `com.meta.react.turbomodulemanager.queue`, Android
 * the native modules thread); any other return type runs inline on the JS
 * thread. `addBreadcrumb` returns a boolean, so it is inline.
 *
 * On the iOS simulator the e2e failed with this order: the clear's main-queue
 * uninstall ran, then the record of the restored crumb ran with no filter
 * installed, then the queued re-enable arrived. The crumb was recorded with
 * the secret. These models replay that order.
 */

type Recorded = { message: string };

let native: typeof NativeMock;
let Bugsee: {
  setBreadcrumbFilter(callback?: ((crumb: Record<string, unknown>) => unknown) | null): void;
  addBreadcrumb(crumb: { category: string; level: string; message: string; type: string }): void;
};

beforeEach(() => {
  jest.resetModules();
  ({ native } = require('../../__mocks__/native'));
  Bugsee = require('../../index').default;
});

/** Whether codegen queues `setBreadcrumbFilterEnabled`, read from the spec. */
function enableIsQueued(): { declared: string | undefined; queued: boolean } {
  const source = readFileSync(join(__dirname, '..', '..', 'NativeBugsee.ts'), 'utf8');
  const declared = /\bsetBreadcrumbFilterEnabled\s*\([^)]*\)\s*:\s*([^;]+);/.exec(source)?.[1]?.trim();
  return { declared, queued: declared === 'void' || declared?.startsWith('Promise') === true };
}

/** Pending requests by id, and what native recorded. */
function harness() {
  const pending = new Map<string, string>();
  const recorded: Recorded[] = [];
  let nextRequest = 0;
  native.replyBreadcrumbFilter.mockImplementation((requestId: string, crumbJson: string | null) => {
    const original = pending.get(requestId);
    pending.delete(requestId);
    if (original === undefined || crumbJson === null) {
      return;
    }
    recorded.push({ message: String((JSON.parse(crumbJson) as { message: unknown }).message) });
  });
  /** The filter asks JS: as both bridges do, synchronously inside the record. */
  function ask(message: string, addId: string | null): void {
    nextRequest += 1;
    const requestId = String(nextRequest);
    pending.set(requestId, message);
    native.emitBreadcrumbFilterRequest({
      requestId,
      crumbJson: JSON.stringify({ category: 'e2e', level: 'info', message, type: 'user' }),
      ...(addId === null ? {} : { addId }),
    });
  }
  return { recorded, ask };
}

/**
 * The iOS bridge: enable installs on the queue it runs on; disable bumps the
 * generation and hops to main, where it uninstalls only if no later enable
 * or disable bumped it. A manual add records on main.
 */
function iosModel(queued: boolean) {
  const { recorded, ask } = harness();
  const main: Array<() => void> = [];
  const moduleQueue: Array<() => void> = [];
  let installed = false;
  let generation = 0;
  let beforeAdd: () => void = () => {};
  const dispatch = (body: () => void): void => {
    if (queued) {
      moduleQueue.push(body);
    } else {
      body();
    }
  };
  native.setBreadcrumbFilterEnabled.mockImplementation((enabled: boolean) => {
    dispatch(() => {
      generation += 1;
      if (enabled) {
        installed = true;
        return;
      }
      const captured = generation;
      main.push(() => {
        if (generation === captured) {
          installed = false;
        }
      });
    });
    return true;
  });
  native.addBreadcrumb.mockImplementation((_c, _l, message, _t, _d, addId) => {
    beforeAdd();
    main.push(() => {
      if (installed) {
        ask(message, addId);
      } else {
        recorded.push({ message });
      }
    });
    return addId !== null;
  });
  const runOne = (queue: Array<() => void>): void => {
    queue.shift()?.();
  };
  const drain = (queue: Array<() => void>): void => {
    while (queue.length > 0) {
      runOne(queue);
    }
  };
  return {
    recorded,
    main,
    moduleQueue,
    drain,
    /** Lets the module queue run `n` queued calls before the next add. */
    runBeforeNextAdd(n: number): void {
      beforeAdd = () => {
        beforeAdd = () => {};
        for (let i = 0; i < n; i++) {
          runOne(moduleQueue);
        }
      };
    },
  };
}

/**
 * The Android bridge: `addBreadcrumb` runs inline on the JS thread and the
 * filter is asked inside it; `setEnabled` installs or removes at once on the
 * thread it runs on.
 */
function androidModel(queued: boolean) {
  const { recorded, ask } = harness();
  const moduleQueue: Array<() => void> = [];
  let installed = false;
  let beforeAdd: () => void = () => {};
  native.setBreadcrumbFilterEnabled.mockImplementation((enabled: boolean) => {
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
  native.addBreadcrumb.mockImplementation((_c, _l, message, _t, _d, addId) => {
    beforeAdd();
    if (installed) {
      ask(message, addId);
    } else {
      recorded.push({ message });
    }
    return addId !== null;
  });
  return {
    recorded,
    moduleQueue,
    /** Lets the native modules thread run `n` queued calls before the next add. */
    runBeforeNextAdd(n: number): void {
      beforeAdd = () => {
        beforeAdd = () => {};
        for (let i = 0; i < n; i++) {
          moduleQueue.shift()?.();
        }
      };
    },
  };
}

function redactor(probe: string) {
  return (crumb: Record<string, unknown>) => {
    const message = String(crumb.message);
    return message.includes(probe) ? { ...crumb, message: message.replace('SECRET', 'REDACTED') } : crumb;
  };
}

function add(message: string): void {
  Bugsee.addBreadcrumb({ category: 'e2e', level: 'info', message, type: 'user' });
}

/**
 * The scenario's tail: clear on the add's turn, then redactor, add,
 * passthrough. `beforeRestored` runs between the redactor and the add.
 */
function sameTurnClearThenRestore(beforeRestored: () => void): void {
  add('cleared SECRET');
  Bugsee.setBreadcrumbFilter(null);
  Bugsee.setBreadcrumbFilter(redactor('restored'));
  beforeRestored();
  add('restored SECRET');
  Bugsee.setBreadcrumbFilter((crumb) => crumb);
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('setBreadcrumbFilter under codegen dispatch', () => {
  it('iOS: the clear uninstalling on main before the re-enable runs does not record a secret', async () => {
    const { queued } = enableIsQueued();
    const ios = iosModel(queued);
    Bugsee.setBreadcrumbFilter(redactor('cleared'));
    ios.drain(ios.moduleQueue);
    ios.drain(ios.main);

    // The order seen on the simulator: the module queue runs the clear while
    // the JS turn is still going, main then runs everything it has (the
    // uninstall, then the restored record), and only then does the queue
    // run the re-enable.
    sameTurnClearThenRestore(() => ios.runBeforeNextAdd(1));
    ios.drain(ios.main);
    ios.drain(ios.moduleQueue);
    ios.drain(ios.main);
    await flush();

    const messages = ios.recorded.map((r) => r.message);
    expect(messages.filter((m) => m.includes('SECRET'))).toEqual([]);
    expect(messages).toEqual(['cleared REDACTED', 'restored REDACTED']);
  });

  it('iOS: a crumb added on the line after the first install is filtered', async () => {
    const { queued } = enableIsQueued();
    const ios = iosModel(queued);
    Bugsee.setBreadcrumbFilter(redactor('immediate'));
    add('immediate SECRET');
    ios.drain(ios.main);
    ios.drain(ios.moduleQueue);
    ios.drain(ios.main);
    await flush();

    expect(ios.recorded.map((r) => r.message)).toEqual(['immediate REDACTED']);
  });

  it('Android: the clear running before the restored add does not record a secret', async () => {
    const { queued } = enableIsQueued();
    const android = androidModel(queued);
    Bugsee.setBreadcrumbFilter(redactor('cleared'));
    android.moduleQueue.splice(0).forEach((run) => run());

    // The native modules thread runs the clear, not yet the re-enable,
    // while the JS thread is inside the restored add.
    sameTurnClearThenRestore(() => android.runBeforeNextAdd(1));
    android.moduleQueue.splice(0).forEach((run) => run());
    await flush();

    const messages = android.recorded.map((r) => r.message);
    expect(messages.filter((m) => m.includes('SECRET'))).toEqual([]);
    expect(messages).toEqual(['cleared REDACTED', 'restored REDACTED']);
  });

  it('Android: a crumb added on the line after the first install is filtered', async () => {
    const { queued } = enableIsQueued();
    const android = androidModel(queued);
    Bugsee.setBreadcrumbFilter(redactor('immediate'));
    add('immediate SECRET');
    android.moduleQueue.splice(0).forEach((run) => run());
    await flush();

    expect(android.recorded.map((r) => r.message)).toEqual(['immediate REDACTED']);
  });

  it('setBreadcrumbFilterEnabled returns a value so codegen does not queue it', () => {
    // `void` is queued, and so is a Promise. Only a sync return runs on the
    // JS thread, in order with `addBreadcrumb` on the same turn.
    expect(enableIsQueued().declared).toBe('boolean');
  });
});
