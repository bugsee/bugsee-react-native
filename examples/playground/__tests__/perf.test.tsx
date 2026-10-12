import { fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import PerfScreen, { perfActions } from '../src/screens/PerfScreen';
import { callTarget } from '../src/ui/action';

test('actions have valid call targets and unique ids', () => {
  perfActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(perfActions.map((a) => a.id)).size).toBe(perfActions.length);
});
test('renders labels and pressing an action calls its mock', async () => {
  await render(<PerfScreen />);
  expect(screen.getByText('Get active span')).toBeTruthy();
  await fireEvent.press(screen.getByText('Get active span'));
  expect(Bugsee.getActiveSpan).toHaveBeenCalled();
});
test('slow render finishes the span after commit', async () => {
  await render(<PerfScreen />);
  await fireEvent.press(screen.getByText('Slow render (3000 rows)'));
  const span = (Bugsee.startSpan as jest.Mock).mock.results.at(-1)!.value;
  expect(Bugsee.startSpan).toHaveBeenCalledWith('ui.render', 'slow list');
  expect(await screen.findByText('Row 2999')).toBeTruthy();
  expect(span.finish).toHaveBeenCalled();
});
