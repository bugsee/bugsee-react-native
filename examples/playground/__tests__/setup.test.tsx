import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { Status } from '@bugsee/react-native';
import { SessionContext } from '../src/session/SessionContext';
import type { Session } from '../src/session/SessionContext';
import { DEFAULT_CONFIG } from '../src/session/config';
import SetupScreen, { RELAUNCHED } from '../src/screens/SetupScreen';
import { ADVANCED_KEYS } from '../src/options/advanced';
import ScanScreen from '../src/screens/ScanScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
let mockExtra: Record<string, unknown> = {};
jest.mock('expo-constants', () => ({ __esModule: true, default: { get expoConfig() { return { extra: mockExtra }; } } }));
let mockOnScan: ((e: { data: string }) => void) | undefined;
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  return {
    CameraView: (p: { onBarcodeScanned: (e: { data: string }) => void }) => { mockOnScan = p.onBarcodeScanned; return <View />; },
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

const VALID = '00000000-0000-4000-8000-000000000001';
function session(over: Partial<Session> = {}): Session {
  return {
    ready: true, config: { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common } }, setConfig: jest.fn(async () => {}), status: 0,
    lifecycle: [], note: jest.fn(),
    launch: jest.fn(async () => true), relaunch: jest.fn(async () => true), stop: jest.fn(async () => true),
    pendingToken: null, setPendingToken: jest.fn(), ...over,
  };
}
const PLACEHOLDER = "Leave empty for the build's default (Bugsee cloud unless bugsee.config.json sets one)";
const withSession = (s: Session, ui = <SetupScreen />) => <SessionContext.Provider value={s}>{ui}</SessionContext.Provider>;

// Pays the one-time cold render cost (module init, the long Advanced list) here, not inside the first test.
beforeAll(async () => {
  const view = await render(withSession(session()));
  await view.unmount();
}, 30000);
beforeEach(() => { jest.clearAllMocks(); mockExtra = {}; });

test('a non-UUID token shows an error and disables Launch', async () => {
  await render(withSession(session()));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), 'abc');
  expect(screen.getByText('Must be a UUID')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Launch' }).props.accessibilityState?.disabled).toBe(true);
});

test('valid token + Launch saves, launches and navigates', async () => {
  const s = session();
  await render(withSession(s));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
  // everLaunched is the session's to set, after a successful launch (m3).
  expect(s.setConfig).toHaveBeenCalledWith(expect.objectContaining({ token: VALID, everLaunched: false }));
  expect(s.launch).toHaveBeenCalledTimes(1);
  expect(s.stop).not.toHaveBeenCalled();
  expect(s.note).not.toHaveBeenCalled();
});

test('goes back instead of stacking a second tabs navigator when it can', async () => {
  mockRouter.canGoBack.mockReturnValueOnce(true);
  await render(withSession(session()));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test.each([Status.Launched, Status.Launching])(
  'with Bugsee running (status %s) Launch stops, then launches',
  async (st) => {
    const order: string[] = [];
    const s = session({
      status: st,
      stop: jest.fn(async () => { order.push('stop'); return true; }),
      launch: jest.fn(async () => { order.push('launch'); return true; }),
    });
    await render(withSession(s));
    await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
    await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
    expect(order).toEqual(['stop', 'launch']);
    expect(s.note).toHaveBeenCalledWith(RELAUNCHED);
  },
);

test('shows the cocoa-196 known issue under Capture video (iOS)', async () => {
  await render(withSession(session()));
  expect(screen.getByText('⚠ Known issue: capture.video=false still records')).toBeTruthy();
});

test('pre-fills the endpoint from bugsee.config.json when none is saved', async () => {
  mockExtra = { bugseeEndpoint: 'https://bugsee.example.com' };
  await render(withSession(session()));
  const ep = screen.getByPlaceholderText(PLACEHOLDER);
  expect(ep.props.value).toBe('https://bugsee.example.com');
  expect(screen.getByText('From bugsee.config.json')).toBeTruthy();
  await fireEvent.changeText(ep, 'https://other.example.com');
  expect(screen.queryByText('From bugsee.config.json')).toBeNull();
});

test('a saved endpoint wins over bugsee.config.json', async () => {
  mockExtra = { bugseeEndpoint: 'https://bugsee.example.com' };
  await render(withSession(session({ config: { ...DEFAULT_CONFIG, endpoint: 'https://saved.example.com' } })));
  expect(screen.getByPlaceholderText(PLACEHOLDER).props.value).toBe('https://saved.example.com');
  expect(screen.queryByText('From bugsee.config.json')).toBeNull();
});

test('warns when the build-time prefix differs from the typed token', async () => {
  mockExtra = { bugseeTokenPrefix: { [Platform.OS]: '1a2b3c4d' } };
  await render(withSession(session()));
  expect(screen.getByText('Build-time token configured: 1a2b3c4d…; paste the full token')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  expect(screen.getByText(/Symbols were uploaded for app 1a2b3c4d…/)).toBeTruthy();
  expect(screen.getByText(/launching with 0000…/)).toBeTruthy();
});

test('endpoint is empty by default with a placeholder, and rejects http', async () => {
  await render(withSession(session()));
  const ep = screen.getByPlaceholderText(PLACEHOLDER);
  expect(ep.props.value).toBe('');
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.changeText(ep, 'http://x');
  expect(screen.getByText('Must be an https URL (no /v2)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Launch' }).props.accessibilityState?.disabled).toBe(true);
  await fireEvent.changeText(ep, 'https://bugsee.example.com/v2');
  expect(screen.getByText('Must be an https URL (no /v2)')).toBeTruthy();
  await fireEvent.changeText(ep, 'https://bugsee.example.com/v2/');
  expect(screen.getByText('Must be an https URL (no /v2)')).toBeTruthy();
  await fireEvent.changeText(ep, 'https://bugsee.example.com');
  expect(screen.queryByText('Must be an https URL (no /v2)')).toBeNull();
});

test('pendingToken fills the token field', async () => {
  const s = session({ pendingToken: VALID });
  await render(withSession(s));
  expect(screen.getByPlaceholderText('App token').props.value).toBe(VALID);
  expect(s.setPendingToken).toHaveBeenCalledWith(null);
});

test('Scan QR pushes /scan', async () => {
  await render(withSession(session()));
  await fireEvent.press(screen.getByText('Scan QR'));
  expect(mockRouter.push).toHaveBeenCalledWith('/scan');
});

test('advanced options are collapsed, expand, and are saved when set (emptied ones removed)', async () => {
  const s = session({ config: { ...DEFAULT_CONFIG, advanced: { 'com.bugsee.option.zzz': '1' } } });
  await render(withSession(s));
  expect(screen.queryByPlaceholderText('Filter options')).toBeNull();
  await fireEvent.press(screen.getByText('Show options'));
  expect(screen.getByPlaceholderText('Filter options')).toBeTruthy();
  const key = ADVANCED_KEYS[0];
  const label = `Option ${key.replace('com.bugsee.option.', '')}`;
  await fireEvent.changeText(screen.getByLabelText(label), 'abc');
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(s.setConfig).toHaveBeenCalled());
  expect((s.setConfig as jest.Mock).mock.calls[0][0].advanced[key]).toBe('abc');
  await fireEvent.changeText(screen.getByLabelText(label), '');
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(s.setConfig).toHaveBeenCalledTimes(2));
  expect(key in (s.setConfig as jest.Mock).mock.calls[1][0].advanced).toBe(false);
});

test('a rejecting launch shows the error and does not navigate', async () => {
  const s = session({ launch: jest.fn(async () => { throw new Error('boom'); }) });
  await render(withSession(s));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  expect(await screen.findByText('Launch failed: boom')).toBeTruthy();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test('a false launch result shows the message and does not navigate', async () => {
  const s = session({ launch: jest.fn(async () => false) });
  await render(withSession(s));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  expect(await screen.findByText(/Bugsee did not launch/)).toBeTruthy();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test('a double press launches once', async () => {
  const s = session();
  await render(withSession(s));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  const b = screen.getByRole('button', { name: 'Launch' });
  await act(async () => { b.props.onClick(); b.props.onClick(); });
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
  expect(s.launch).toHaveBeenCalledTimes(1);
});

test('partial numeric input is kept raw; invalid disables Launch; valid is saved as integer', async () => {
  const s = session();
  await render(withSession(s));
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.changeText(screen.getByLabelText('Duration'), '1.');
  expect(screen.getByLabelText('Duration').props.value).toBe('1.');
  expect(screen.getByText('Must be a whole number ≥ 0')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Launch' }).props.accessibilityState?.disabled).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Duration'), '-');
  expect(screen.getByLabelText('Duration').props.value).toBe('-');
  await fireEvent.changeText(screen.getByLabelText('Duration'), '30');
  await fireEvent.press(screen.getByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(s.setConfig).toHaveBeenCalled());
  expect((s.setConfig as jest.Mock).mock.calls[0][0].common.duration).toBe(30);
});

describe('ScanScreen', () => {
  test('shows an error for a non-token payload', async () => {
    await render(withSession(session(), <ScanScreen />));
    await act(async () => { mockOnScan!({ data: 'nope' }); });
    expect(screen.getByText('Not a Bugsee app token')).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
  test('handles a valid payload once', async () => {
    const s = session();
    await render(withSession(s, <ScanScreen />));
    await act(async () => { mockOnScan!({ data: `BGSAPT:${VALID}` }); mockOnScan!({ data: `BGSAPT:${VALID}` }); });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(s.setPendingToken).toHaveBeenCalledWith(VALID);
  });
});
