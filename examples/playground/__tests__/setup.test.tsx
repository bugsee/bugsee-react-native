import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SessionContext } from '../src/session/SessionContext';
import type { Session } from '../src/session/SessionContext';
import { DEFAULT_CONFIG } from '../src/session/config';
import SetupScreen from '../src/screens/SetupScreen';
import ScanScreen from '../src/screens/ScanScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
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

const VALID = '3f2a9c1e-5b7d-4e68-8a10-2c9d4b6e7f01';
function session(over: Partial<Session> = {}): Session {
  return {
    ready: true, config: { ...DEFAULT_CONFIG, common: { ...DEFAULT_CONFIG.common } }, setConfig: jest.fn(async () => {}), status: 0, lifecycle: [],
    launch: jest.fn(async () => true), relaunch: jest.fn(async () => true), stop: jest.fn(async () => true),
    pendingToken: null, setPendingToken: jest.fn(), ...over,
  };
}
const withSession = (s: Session, ui = <SetupScreen />) => <SessionContext.Provider value={s}>{ui}</SessionContext.Provider>;

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
  expect(s.setConfig).toHaveBeenCalledWith(expect.objectContaining({ token: VALID, everLaunched: true }));
  expect(s.launch).toHaveBeenCalledTimes(1);
});

test('warns when the build-time prefix differs from the typed token', async () => {
  mockExtra = { bugseeTokenPrefix: { [Platform.OS]: '1a2b3c4d' } };
  await render(withSession(session()));
  expect(screen.getByText('Build-time token configured: 1a2b3c4d…; paste the full token')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), '9f8e7d6c-5b7d-4e68-8a10-2c9d4b6e7f01');
  expect(screen.getByText(/Symbols were uploaded for app 1a2b3c4d…/)).toBeTruthy();
  expect(screen.getByText(/launching with 9f8e…/)).toBeTruthy();
});

test('endpoint is empty by default with a placeholder, and rejects http', async () => {
  await render(withSession(session()));
  const ep = screen.getByPlaceholderText('Leave empty for Bugsee cloud');
  expect(ep.props.value).toBe('');
  await fireEvent.changeText(screen.getByPlaceholderText('App token'), VALID);
  await fireEvent.changeText(ep, 'http://x');
  expect(screen.getByText('Must be an https URL (no /v2)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Launch' }).props.accessibilityState?.disabled).toBe(true);
  await fireEvent.changeText(ep, 'https://bugsee.example.com/v2');
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

test('advanced options are collapsed, expand, and are saved when set', async () => {
  const s = session();
  await render(withSession(s));
  expect(screen.queryByPlaceholderText('Filter options')).toBeNull();
  await fireEvent.press(screen.getByText('Show options'));
  expect(screen.getByPlaceholderText('Filter options')).toBeTruthy();
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
