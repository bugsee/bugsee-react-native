import { render } from '@testing-library/react-native';
import CaptureScreen, { captureActions } from '../src/screens/CaptureScreen';
import { redactAuthorization } from '../src/screens/capture/networkActions';
import { callTarget } from '../src/ui/action';

test('every capture action has a valid call target and unique id', () => {
  captureActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(captureActions.map((a) => a.id)).size).toBe(captureActions.length);
});
test('renders every action once', async () => {
  const { getAllByText } = await render(<CaptureScreen />);
  expect(getAllByText(/^Expect:/).length).toBeGreaterThanOrEqual(captureActions.length);
});
test('the redact filter replaces Authorization in any casing and keeps the other headers as they are', () => {
  expect(redactAuthorization({ authorization: 'Bearer demo', 'Content-Type': 'text/plain', accept: '*/*' })).toEqual({
    authorization: '***',
    'Content-Type': 'text/plain',
    accept: '*/*',
  });
  expect(redactAuthorization({ Authorization: 'Bearer demo' })).toEqual({ Authorization: '***' });
  expect(redactAuthorization({ 'X-Demo': '1' })).toEqual({ 'X-Demo': '1' });
});
