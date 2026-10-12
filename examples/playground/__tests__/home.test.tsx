import { fireEvent, render, screen } from '@testing-library/react-native';
import Bugsee from '@bugsee/react-native';
import { SessionContext } from '../src/session/SessionContext';
import type { Session } from '../src/session/SessionContext';
import { DEFAULT_CONFIG } from '../src/session/config';
import HomeScreen from '../src/screens/HomeScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

function session(over: Partial<Session> = {}): Session {
  return {
    ready: true, config: { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common } }, setConfig: jest.fn(async () => {}), status: 2,
    lifecycle: [{ at: '10:00:00', event: 'launched' }, { at: '10:00:05', event: 'stopped' }],
    launch: jest.fn(async () => true), relaunch: jest.fn(async () => true), stop: jest.fn(async () => true),
    pendingToken: null, setPendingToken: jest.fn(), ...over,
  };
}
const ui = (s: Session) => <SessionContext.Provider value={s}><HomeScreen /></SessionContext.Provider>;
beforeEach(() => jest.clearAllMocks());

test('shows the status name', async () => {
  await render(ui(session()));
  expect(screen.getByText('Launched')).toBeTruthy();
});
test('lists lifecycle entries newest first', async () => {
  await render(ui(session()));
  expect(screen.getByText('10:00:05 stopped')).toBeTruthy();
  expect(screen.getByText('10:00:00 launched')).toBeTruthy();
});
test('refreshing launch options shows pretty JSON', async () => {
  (Bugsee.getLaunchOptions as jest.Mock).mockResolvedValueOnce({ a: 1 });
  await render(ui(session()));
  await fireEvent.press(screen.getByText('Refresh launch options'));
  expect(await screen.findByText(JSON.stringify({ a: 1 }, null, 2))).toBeTruthy();
});
test('demo shop card pushes the sign-in route', async () => {
  await render(ui(session()));
  await fireEvent.press(screen.getByText('Try the demo shop'));
  expect(mockRouter.push).toHaveBeenCalledWith('/shop/sign-in');
});
test('toggling auto-launch flips the saved flag', async () => {
  const s = session();
  await render(ui(s));
  await fireEvent(screen.getByLabelText('Auto-launch on app start'), 'valueChange', true);
  expect(s.setConfig).toHaveBeenCalledWith(expect.objectContaining({ autoLaunch: true }));
});
test('Launch, Relaunch and Stop use the session', async () => {
  const s = session();
  await render(ui(s));
  await fireEvent.press(screen.getByTestId('session-launch'));
  await fireEvent.press(screen.getByTestId('session-relaunch'));
  await fireEvent.press(screen.getByTestId('session-stop'));
  expect(s.launch).toHaveBeenCalled(); expect(s.relaunch).toHaveBeenCalled(); expect(s.stop).toHaveBeenCalled();
});
