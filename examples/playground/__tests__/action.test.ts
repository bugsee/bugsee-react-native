import { callTarget } from '../src/ui/action';
test.each([
  ['Bugsee.log("hi", LogLevel.Info)', 'Bugsee', 'log'],
  ['Bugsee.appearance.backgroundColor = "#222"', 'Bugsee', 'appearance'],
  ['Feedback.showFeedbackUI()', 'Feedback', 'showFeedbackUI'],
  ['PlaygroundNative.crash("segv")', 'PlaygroundNative', 'crash'],
  ['console.warn("x")', 'console', 'warn'],
  ['fetch("https://httpbin.org/get")', 'global', 'fetch'],
  ['new XMLHttpRequest()', 'global', 'XMLHttpRequest'],
  ['new WebSocket(ECHO)', 'global', 'WebSocket'],
  ['report.addDataAttachment(...)', 'report', 'addDataAttachment'],
  ['global Promise rejection (no catch)', 'global', 'Promise'],
])('%s → %s.%s', (call, object, member) => expect(callTarget(call)).toEqual({ object, member }));
test('unknown call shapes throw so a typo cannot pass the mapping test', () => {
  expect(() => callTarget('Bugse.log()')).toThrow();
});
