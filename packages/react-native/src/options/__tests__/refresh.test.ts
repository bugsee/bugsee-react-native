import { BugseeLaunchOptions } from '../BugseeLaunchOptions';
import { IOSLaunchOptions } from '../IOSLaunchOptions';
import { AndroidLaunchOptions } from '../AndroidLaunchOptions';

/**
 * A getter answers from what the app set; failing that, from what the SDK
 * last reported. The wrapper hardcodes no defaults at all — the 6.x
 * implementation did and drifted, shipping `videoMode = V3` after 7.x removed
 * that value.
 */
describe('reading back what the SDK reports', () => {
  it('answers a getter the app never set', () => {
    const options = new AndroidLaunchOptions();
    expect(options.captureLogs).toBeUndefined();

    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.capture.logs': true,
    });
    expect(options.captureLogs).toBe(true);
  });

  // What the app set wins: the SDK's report can lag a set that has not been
  // sent yet, and the caller should read their own intent back.
  it('does not overwrite what the app set', () => {
    const options = new AndroidLaunchOptions();
    options.captureLogs = false;
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.capture.logs': true,
    });
    expect(options.captureLogs).toBe(false);
  });

  // The reported set is NOT the payload. Serialising it back would send the
  // SDK its own defaults as if the app had chosen them, which is exactly how
  // a default becomes un-changeable later.
  it('never becomes part of the payload', () => {
    const options = new AndroidLaunchOptions();
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.capture.logs': true,
      'com.bugsee.option.config.duration': 60,
    });
    expect(BugseeLaunchOptions.serialize(options)).toEqual({});
  });

  it('still serialises what the app set', () => {
    const options = new AndroidLaunchOptions();
    options.duration = 90;
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.config.duration': 60,
    });
    expect(BugseeLaunchOptions.serialize(options))
      .toEqual({ 'com.bugsee.option.config.duration': 90 });
    expect(options.duration).toBe(90);
  });

  it('replaces the previous report rather than merging into it', () => {
    const options = new AndroidLaunchOptions();
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.capture.logs': true,
    });
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.config.duration': 60,
    });
    expect(options.captureLogs).toBeUndefined();
    expect(options.duration).toBe(60);
  });

  it('clearing an app value falls back to the reported one', () => {
    const options = new AndroidLaunchOptions();
    options.captureLogs = false;
    BugseeLaunchOptions.refreshFrom(options, {
      'com.bugsee.option.capture.logs': true,
    });
    options.captureLogs = undefined;
    expect(options.captureLogs).toBe(true);
  });

  it('works through the endpoint accessor too', () => {
    const options = new IOSLaunchOptions();
    BugseeLaunchOptions.refreshFrom(options, {
      endpoint: 'https://apidev.bugsee.com/v2',
    });
    expect(options.endpoint).toBe('https://apidev.bugsee.com/v2');
  });

  it('ignores a null report, which is what a bridge sends for "nothing"', () => {
    const options = new AndroidLaunchOptions();
    options.captureLogs = true;
    BugseeLaunchOptions.refreshFrom(options, null as never);
    expect(options.captureLogs).toBe(true);
  });

  it('ignores a report that is not an object', () => {
    const options = new AndroidLaunchOptions();
    options.captureLogs = true;
    BugseeLaunchOptions.refreshFrom(options, undefined as never);
    expect(options.captureLogs).toBe(true);
  });
});
