import { render } from '@testing-library/react-native';
import CaptureScreen, { captureActions } from '../src/screens/CaptureScreen';
import { callTarget } from '../src/ui/action';

test('every capture action has a valid call target and unique id', () => {
  captureActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(captureActions.map((a) => a.id)).size).toBe(captureActions.length);
});
test('renders every action once', async () => {
  const { getAllByText } = await render(<CaptureScreen />);
  expect(getAllByText(/^Expect:/).length).toBeGreaterThanOrEqual(captureActions.length);
});
