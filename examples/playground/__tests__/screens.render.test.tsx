import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SessionProvider } from '../src/session/SessionProvider';
import { ALL_ACTIONS } from '../src/screens/allActions';
import CaptureScreen from '../src/screens/CaptureScreen';
import DataScreen from '../src/screens/DataScreen';
import ErrorsScreen from '../src/screens/ErrorsScreen';
import HomeScreen from '../src/screens/HomeScreen';
import PerfScreen from '../src/screens/PerfScreen';
import PrivacyScreen from '../src/screens/PrivacyScreen';
import ReportsScreen from '../src/screens/ReportsScreen';
import ScanScreen from '../src/screens/ScanScreen';
import SetupScreen from '../src/screens/SetupScreen';
import Checkout from '../src/screens/shop/Checkout';
import ProductDetail from '../src/screens/shop/ProductDetail';
import Products from '../src/screens/shop/Products';
import SignIn from '../src/screens/shop/SignIn';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  Stack: Object.assign(({ children }: { children?: unknown }) => children ?? null, { Screen: () => null }),
}));

const productsBody = { products: [{ id: 1, title: 'Widget', price: 9.5, description: 'A widget' }] };

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => productsBody,
    text: async () => '{}',
  })) as never;
});

// Actions the screen renders under a different caption than the action's label.
const RENDERED_AS: Record<string, string> = { 'home/launch-options': 'Refresh launch options' };

const inSession = (ui: ReactElement) => <SessionProvider>{ui}</SessionProvider>;

const tabScreens: [string, () => ReactElement][] = [
  ['home', () => <HomeScreen />],
  ['capture', () => <CaptureScreen />],
  ['privacy', () => <PrivacyScreen />],
  ['errors', () => <ErrorsScreen />],
  ['reports', () => <ReportsScreen />],
  ['data', () => <DataScreen />],
  ['perf', () => <PerfScreen />],
];

describe.each(tabScreens)('%s screen', (name, ui) => {
  test('renders every visible action label', async () => {
    await render(inSession(ui()));
    const visible = ALL_ACTIONS.filter(
      (a) => a.screen === name && (!a.action.platforms || a.action.platforms.includes('ios')),
    );
    expect(visible.length).toBeGreaterThan(0);
    for (const { action } of visible) {
      const text = RENDERED_AS[`${name}/${action.id}`] ?? action.label;
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });
});

const otherScreens: [string, () => ReactElement][] = [
  ['setup', () => <SetupScreen />],
  ['scan', () => <ScanScreen />],
  ['shop sign-in', () => <SignIn />],
  ['shop products', () => <Products />],
  ['shop product detail', () => <ProductDetail />],
  ['shop checkout', () => <Checkout />],
];

test.each(otherScreens)('%s renders without throwing', async (_name, ui) => {
  await expect(render(inSession(ui()))).resolves.toBeDefined();
});
