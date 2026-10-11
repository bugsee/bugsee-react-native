import { TEST_CRASH_FRAME, isObfuscatedPosition, refusedRunAs } from '../../examples/bare/e2e/retrace';

// F7: the S-4 case must refuse a build that is not obfuscated, or it passes
// without exercising retrace (ART-111 on staging).
describe('S-4 retrace checks', () => {
  it('finds the wrapper frame in a logcat trace line and takes its position', () => {
    const line = '10-11 18:40:01.123 E AndroidRuntime: \tat com.bugsee.reactnative.BugseeModule.testCrash(r8-map-id-04edd988:1)';
    expect(TEST_CRASH_FRAME.exec(line)?.[1]).toBe('r8-map-id-04edd988:1');
    expect(TEST_CRASH_FRAME.exec('at com.bugsee.reactnative.BugseeModule.testCrashX(a:1)')).toBeNull();
    expect(TEST_CRASH_FRAME.exec('at xcom.bugsee.reactnative.BugseeModule.testCrash(a:1)')).toBeNull();
  });

  it.each(['r8-map-id-04edd988:1', 'SourceFile:12', 'a:1', ' r8-map-id-1:1 '])('takes %j for obfuscated', (position) => {
    expect(isObfuscatedPosition(position)).toBe(true);
  });

  it.each(['BugseeModule.java:493', 'BugseeModule.java', 'Unknown Source', '', '  ', ' BugseeModule.java:1 '])(
    'takes %j for a readable, unobfuscated build',
    (position) => {
      expect(isObfuscatedPosition(position)).toBe(false);
    },
  );

  // Both wordings: older Android puts the package last, newer in the middle.
  it('recognises run-as refusing a non-debuggable package, and only that', () => {
    expect(refusedRunAs('run-as: package not debuggable: com.bareexample')).toBe(true);
    expect(refusedRunAs('run-as: package com.bareexample is not debuggable\n')).toBe(true);
    expect(refusedRunAs('')).toBe(false);
    expect(refusedRunAs('run-as: unknown package: com.bareexample')).toBe(false);
  });
});
