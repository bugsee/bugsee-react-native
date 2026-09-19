import {
  ANDROID_EVENT_PREFIX,
  EVENTS_CARRYING_REPORT_ID,
  LIFECYCLE_EVENTS,
  wireEventName,
  eventFromWireName,
  firesOn,
  type LifecycleEventName,
} from '../lifecycle-events';

const names = Object.keys(LIFECYCLE_EVENTS) as LifecycleEventName[];

describe('the exposed set', () => {
  // Surfacing an event that never fires is worse than omitting it: the
  // listener simply never runs, and nothing tells the caller why.
  it('exposes only events that fire somewhere', () => {
    for (const name of names) {
      const where = LIFECYCLE_EVENTS[name];
      expect(where.android || where.ios).toBe(true);
    }
  });

  // Both SDKs dispatch all sixteen since iOS 7.0.0-beta2 implemented the
  // wrapper channel; beta1 sent only six.
  it('covers what the SDKs dispatch, and no more', () => {
    expect(names).toHaveLength(16);
    expect(names.filter((n) => LIFECYCLE_EVENTS[n].ios)).toHaveLength(16);
    expect(names.filter((n) => LIFECYCLE_EVENTS[n].android)).toHaveLength(16);
  });

  // Paused/Resumed were DELETED from iOS in 7.0.0-beta2 -- 7.x has no
  // pause/resume API and nothing dispatched them. The feedback events survive
  // in the delegate enum but are not part of the wrapper's name set.
  it.each(['Paused', 'Resumed', 'Started', 'BeforeFeedbackShown', 'AfterFeedbackShown'])(
    'omits %s, which the wrapper channel does not carry',
    (name) => {
      expect(names).not.toContain(name);
    },
  );

  it('has no platform-only event today', () => {
    expect(names.filter((n) => LIFECYCLE_EVENTS[n].ios !== LIFECYCLE_EVENTS[n].android))
      .toEqual([]);
  });
});

describe('the Android wire form', () => {
  it('prefixes the name', () => {
    expect(wireEventName('Launched')).toBe('com.bugsee.lifecycle.Launched');
  });

  it('round-trips every exposed event', () => {
    for (const name of names) {
      expect(eventFromWireName(wireEventName(name))).toBe(name);
    }
  });

  // An unknown event means the SDK grew one; dropping it is right, guessing
  // at a name is not.
  it('returns undefined for an event it does not know', () => {
    expect(eventFromWireName('com.bugsee.lifecycle.Invented')).toBeUndefined();
  });

  it('returns undefined for something outside the namespace', () => {
    expect(eventFromWireName('Launched')).toBeUndefined();
    expect(eventFromWireName('com.example.Launched')).toBeUndefined();
    expect(eventFromWireName('')).toBeUndefined();
  });

  it('uses the namespace the SDK actually sends', () => {
    expect(ANDROID_EVENT_PREFIX).toBe('com.bugsee.lifecycle.');
  });
});

describe('firesOn', () => {
  it('answers per platform', () => {
    expect(firesOn('Launched', 'ios')).toBe(true);
    expect(firesOn('Launching', 'ios')).toBe(true);
    expect(firesOn('Launching', 'android')).toBe(true);
  });
});

describe('the report id', () => {
  // `data` is the report's id for the assembly and upload events and nil for
  // the rest -- including Before/AfterReportShown, which the report UI
  // announces before a report exists.
  it('rides only the assembly and upload events', () => {
    expect([...EVENTS_CARRYING_REPORT_ID].sort()).toEqual([
      'AfterReportAssembled', 'AfterReportUploaded', 'BeforeReportAssembled',
      'BeforeReportUploaded', 'ReportAssemblyFailed', 'ReportUploadFailed',
      'ReportUploadFailedWithFutureRetry',
    ]);
  });

  it('never rides the report-shown events', () => {
    expect(EVENTS_CARRYING_REPORT_ID).not.toContain('BeforeReportShown');
    expect(EVENTS_CARRYING_REPORT_ID).not.toContain('AfterReportShown');
  });

  it('names only events that exist', () => {
    for (const name of EVENTS_CARRYING_REPORT_ID) {
      expect(names).toContain(name);
    }
  });
});
