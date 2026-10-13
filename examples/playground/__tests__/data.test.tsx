import { fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import DataScreen, { dataActions } from '../src/screens/DataScreen';
import { callTarget } from '../src/ui/action';

test('every data action has a valid call target and unique id', () => {
  dataActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(dataActions.map((a) => a.id)).size).toBe(dataActions.length);
});
test('renders every action and pressing one calls the mock', async () => {
  await render(<DataScreen />);
  expect(screen.getAllByText(/^Expect:/).length).toBe(dataActions.length);
  await fireEvent.press(screen.getByText('Event with params'));
  expect(Bugsee.event).toHaveBeenCalledWith('purchase', { sku: 'A-1', qty: 2, gift: false });
});
