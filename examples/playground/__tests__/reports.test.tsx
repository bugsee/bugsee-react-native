import { fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import * as Feedback from '@bugsee/react-native-feedback';
import ReportsScreen, { reportsActions } from '../src/screens/ReportsScreen';
import { callTarget } from '../src/ui/action';

test('every reports action has a valid call target and unique id', () => {
  reportsActions.forEach((a) => expect(() => callTarget(a.call)).not.toThrow());
  expect(new Set(reportsActions.map((a) => a.id)).size).toBe(reportsActions.length);
});
test('renders labels', async () => {
  await render(<ReportsScreen />);
  expect(screen.getByText('Show report dialog (prefilled)')).toBeTruthy();
  expect(screen.getByText('Create report')).toBeTruthy();
  expect(screen.getByText('Redact (no drop API in 7.x)')).toBeTruthy();
});
test('created-report steps before createReport log the error', async () => {
  await render(<ReportsScreen />);
  await fireEvent.press(screen.getByText('Report: read'));
  expect(await screen.findByText(/Call Bugsee.createReport\(\) first/)).toBeTruthy();
});
test('createReport then report.update calls the created object', async () => {
  await render(<ReportsScreen />);
  await fireEvent.press(screen.getByText('Create report'));
  const created = await (Bugsee.createReport as jest.Mock).mock.results[0].value;
  await fireEvent.press(screen.getByText('Report: update'));
  expect(created.update).toHaveBeenCalledWith({ summary: 'Created report', labels: ['created'], attributes: { step: 1 } });
  await fireEvent.press(screen.getByText('Report: upload'));
  expect(created.upload).toHaveBeenCalled();
});
test('appearance and feedback listener actions', async () => {
  await render(<ReportsScreen />);
  await fireEvent.press(screen.getByText('Set report colours'));
  expect((Bugsee.appearance as Record<string, unknown>).backgroundColor).toBe('#1d2939');
  await fireEvent.press(screen.getByText('Set feedback listener'));
  expect(Feedback.setListener).toHaveBeenCalled();
});
