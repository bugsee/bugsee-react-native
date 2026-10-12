import Bugsee, { BugseeLaunchOptions, createDefaultLaunchOptions, Status } from '@bugsee/react-native';
import { setGreeting } from '@bugsee/react-native-feedback';
import { PlaygroundNative } from '../modules/playground-native';

test('facade mock keeps real option exports and stubs methods', async () => {
  expect(typeof BugseeLaunchOptions.serialize).toBe('function');
  expect(typeof createDefaultLaunchOptions).toBe('function');
  expect(Status.Launched).toBe(2);
  expect(await Bugsee.launch('t')).toBe(true);
  expect(await Bugsee.getStatus()).toBe(2);
  expect(() => Bugsee.testJsCrash()).not.toThrow();
  expect(Bugsee.onStatusChange(() => {})).toEqual({ remove: expect.any(Function) });
  const report = await Bugsee.createReport();
  expect(await report!.upload()).toBe(true);
  expect(Bugsee.startSpan('x').startChildSpan('y').setName('z')).toBeTruthy();
  expect(jest.isMockFunction(setGreeting)).toBe(true);
  expect(PlaygroundNative.available).toBe(true);
  expect(await PlaygroundNative.request('GET', 'u')).toEqual({ status: 200, body: '{}' });
  // sync in the real SDK: must not return promises
  expect(Bugsee.log('x')).toBeUndefined();
  expect(Bugsee.setUserIdentifier('u')).toBeUndefined();
  expect(Bugsee.startBlackout()).toBeUndefined();
  expect(Bugsee.getActiveSpan()).toBeTruthy();
  expect(typeof Bugsee.startSpan('x').finish).toBe('function');
  // async in the real SDK: must return promises
  for (const p of [Bugsee.setAttribute('a', 'b'), Bugsee.getAttribute('a'), Bugsee.getUserIdentifier(), Bugsee.attach(), Bugsee.logUnhandledException(new Error('x'))]) {
    expect(p).toBeInstanceOf(Promise);
  }
});
