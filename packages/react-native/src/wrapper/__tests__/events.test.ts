import { statusForEvent, type LifecycleEvent } from '../events';
import { Status } from '../../status';

describe('statusForEvent', () => {
  /**
   * Status is DERIVED from the lifecycle channel rather than being a second
   * native emitter. Android exposes no status listener at all (only
   * getStatus()), and iOS's bugseeDidChangeStatus: belongs to the app's own
   * BugseeDelegate -- taking it would steal it from the app. One source, one
   * mapping, tested once for both platforms.
   */
  it.each([
    ['Launching', Status.Launching],
    ['Launched', Status.Launched],
    ['Stopping', Status.Stopping],
    ['Stopped', Status.Stopped],
  ] as const)('maps %s to its status', (name, status) => {
    expect(statusForEvent({ name })).toBe(status);
  });

  /**
   * Every other event leaves the status alone. Reporting a status for, say,
   * AfterReportUploaded would tell a caller the SDK had transitioned when it
   * had not -- worse than silence, because it looks like information.
   */
  it.each([
    'RelaunchedAfterCrash',
    'BeforeReportUploaded',
    'AfterReportUploaded',
    'BlackoutStarted',
  ] as const)('reports no status change for %s', (name) => {
    expect(statusForEvent({ name })).toBeUndefined();
  });

  /**
   * An event a newer SDK adds must not be read as a status. Unknown means
   * unknown, not Stopped -- a caller waiting to start would otherwise be told
   * the SDK had stopped.
   */
  it('reports no status for an unknown event', () => {
    expect(statusForEvent({ name: 'SomethingNewIn8x' } as LifecycleEvent))
      .toBeUndefined();
  });
});
