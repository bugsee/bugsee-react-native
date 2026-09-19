import { native } from '../../__mocks__/native';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', constants: { reactNativeVersion: { major: 0, minor: 87, patch: 1 } } },
}));
jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import Bugsee, { Status } from '../../index';

beforeEach(() => native.reset());

describe('onLifecycleEvent', () => {
  it('delivers the event, report id and all', () => {
    const seen: unknown[] = [];
    Bugsee.onLifecycleEvent((e) => seen.push(e));

    native.emitLifecycle({ name: 'AfterReportUploaded', reportId: 'abc' });

    expect(seen).toEqual([{ name: 'AfterReportUploaded', reportId: 'abc' }]);
  });

  it('delivers an event a newer SDK adds rather than dropping it', () => {
    const seen: string[] = [];
    Bugsee.onLifecycleEvent((e) => seen.push(e.name));

    native.emitLifecycle({ name: 'SomethingNewIn8x' });

    expect(seen).toEqual(['SomethingNewIn8x']);
  });

  // A subscription that cannot be cancelled is a leak in a component tree,
  // where subscribing in an effect is the normal shape.
  it('stops delivering after remove, and detaches natively', () => {
    const seen: string[] = [];
    const subscription = Bugsee.onLifecycleEvent((e) => seen.push(e.name));

    subscription.remove();
    native.emitLifecycle({ name: 'Launched' });

    expect(seen).toEqual([]);
    expect(native.lifecycleListenerCount()).toBe(0);
  });
});

describe('onStatusChange', () => {
  it('reports a status when the event is a transition', () => {
    const seen: Status[] = [];
    Bugsee.onStatusChange((s) => seen.push(s));

    native.emitLifecycle({ name: 'Launching' });
    native.emitLifecycle({ name: 'Launched' });

    expect(seen).toEqual([Status.Launching, Status.Launched]);
  });

  /**
   * The events that are not transitions must not reach a status subscriber at
   * all. Reporting one would say the SDK had moved when it had not.
   */
  it('stays silent for events that are not transitions', () => {
    const seen: Status[] = [];
    Bugsee.onStatusChange((s) => seen.push(s));

    native.emitLifecycle({ name: 'AfterReportUploaded', reportId: 'x' });
    native.emitLifecycle({ name: 'RelaunchedAfterCrash' });

    expect(seen).toEqual([]);
  });

  it('can be removed independently of a lifecycle subscription', () => {
    const lifecycle: string[] = [];
    const statuses: Status[] = [];
    Bugsee.onLifecycleEvent((e) => lifecycle.push(e.name));
    const status = Bugsee.onStatusChange((s) => statuses.push(s));

    status.remove();
    native.emitLifecycle({ name: 'Launched' });

    expect(statuses).toEqual([]);
    expect(lifecycle).toEqual(['Launched']);
  });
});
