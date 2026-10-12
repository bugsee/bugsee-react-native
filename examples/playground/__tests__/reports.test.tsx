import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import * as Feedback from '@bugsee/react-native-feedback';
import ReportsScreen, { reportsActions, resetReportsState } from '../src/screens/ReportsScreen';
import { callTarget } from '../src/ui/action';

type Created = Record<'read' | 'update' | 'addDataAttachment' | 'upload', jest.Mock>;

beforeEach(() => resetReportsState());

const press = (label: string) => fireEvent.press(screen.getByText(label));
async function createReport(): Promise<Created> {
  await press('Create report');
  const calls = (Bugsee.createReport as jest.Mock).mock.results;
  return (await calls[calls.length - 1].value) as Created;
}

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
  await press('Report: read');
  expect(await screen.findByText(/Call Bugsee.createReport\(\) first/)).toBeTruthy();
});
test('createReport then report.update calls the created object', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  await press('Report: update');
  expect(created.update).toHaveBeenCalledWith({
    summary: 'Created report',
    labels: ['created'],
    attributes: { step: 1 },
  });
});
test('text and PNG attachments carry name and mimeType', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  await press('Report: attach text');
  expect(created.addDataAttachment).toHaveBeenLastCalledWith(globalThis.btoa('hello from the playground'), {
    name: 'note.txt',
    mimeType: 'text/plain',
  });
  await press('Report: attach PNG');
  expect(created.addDataAttachment).toHaveBeenLastCalledWith(expect.stringMatching(/^iVBOR/), {
    name: 'pixel.png',
    mimeType: 'image/png',
  });
});
test('the 4 MiB attachment is a base64 string of the expected length', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  await press('Report: attach 4 MiB');
  const [data, options] = created.addDataAttachment.mock.calls[0];
  expect(data).toHaveLength(Math.ceil((4 * 1024 * 1024) / 3) * 4);
  expect(options).toEqual({ name: 'big.bin' });
});
test('report.read calls the created object', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  await press('Report: read');
  expect(created.read).toHaveBeenCalledTimes(1);
});
test('a successful upload clears the handle', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  await press('Report: upload');
  expect(created.upload).toHaveBeenCalledTimes(1);
  await press('Report: read');
  expect(await screen.findByText(/Call Bugsee.createReport\(\) first/)).toBeTruthy();
  expect(created.read).not.toHaveBeenCalled();
});
test('a failed upload keeps the handle for a retry', async () => {
  await render(<ReportsScreen />);
  const created = await createReport();
  created.upload.mockResolvedValueOnce(false);
  await press('Report: upload');
  await press('Report: read');
  expect(created.read).toHaveBeenCalledTimes(1);
});
test('appearance assignments reach the Bugsee appearance object', async () => {
  await render(<ReportsScreen />);
  await press('Set report colours');
  expect(Bugsee.appearance).toMatchObject({ backgroundColor: '#1d2939', textColor: '#ffffff' });
  await press('Reset colours');
  expect(Bugsee.appearance).toMatchObject({ backgroundColor: '#ffffff', textColor: '#101828' });
});
test('feedback listener logs to the screen and stops after unmount', async () => {
  const view = await render(<ReportsScreen />);
  await press('Set feedback listener');
  const listener = (Feedback.setListener as jest.Mock).mock.lastCall![0];
  await act(async () => listener.onNewMessageSent({ text: 'hi' }));
  expect(await screen.findByText(/feedback sent/)).toBeTruthy();
  await view.unmount();
  expect(() => listener.onNewMessageSent({ text: 'late' })).not.toThrow();
});
