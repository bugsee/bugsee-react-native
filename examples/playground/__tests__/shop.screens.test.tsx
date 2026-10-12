import Bugsee, { SpanStatus } from '@bugsee/react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as demoApi from '../src/demoApi';
import { addToCart, cart, finishFlow, resetCart } from '../src/shop/flow';
import Checkout from '../src/screens/shop/Checkout';
import ProductDetail from '../src/screens/shop/ProductDetail';
import Products from '../src/screens/shop/Products';
import ShopLayout from '../app/shop/_layout';
import SignIn from '../src/screens/shop/SignIn';

const mockParams = { id: '1' };
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const Stack = Object.assign(({ children }: { children?: unknown }) => children ?? null, { Screen: () => null });
  return {
    Stack,
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack }),
  };
});

const bugsee = Bugsee as unknown as Record<string, jest.Mock>;
const productsBody = { products: [{ id: 1, title: 'Widget', price: 9.5, description: 'A widget' }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.id = '1';
  demoApi.forgetCatalog();
  finishFlow(SpanStatus.OK);
  resetCart();
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => productsBody,
    text: async () => '{}',
  })) as never;
});

test('sign-in sets the user id with Remember me on by default', async () => {
  await render(<SignIn />);
  expect(screen.getByLabelText('Remember me').props.value).toBe(true);
  await fireEvent.press(screen.getByText('Sign in'));
  await waitFor(() => expect(bugsee.setUserIdentifier).toHaveBeenCalledWith('shopper@example.com'));
});

test('sign-in with Remember me off sets no user id', async () => {
  await render(<SignIn />);
  await fireEvent(screen.getByLabelText('Remember me'), 'valueChange', false);
  await fireEvent.press(screen.getByText('Sign in'));
  const span = bugsee.startTransaction.mock.results[0].value.startChildSpan.mock.results[0].value;
  await waitFor(() => expect(span.finish).toHaveBeenCalledWith(SpanStatus.OK));
  expect(bugsee.setUserIdentifier).not.toHaveBeenCalled();
});

test('products lists items and records the view event', async () => {
  await render(<Products />);
  await fireEvent.press(await screen.findByText('Widget'));
  expect(bugsee.event).toHaveBeenCalledWith('product_viewed', { id: 1 });
});

test('product detail adds to the cart', async () => {
  await render(<ProductDetail />);
  await screen.findByText('Widget');
  await fireEvent.press(screen.getByText('Add to cart'));
  expect(cart.items).toBe(1);
  expect(bugsee.setAttribute).toHaveBeenCalledWith('cart_items', 1);
  expect(screen.getByText('Checkout')).toBeTruthy();
});

test('checkout declined logs the handled exception', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  addToCart(5);
  await render(<Checkout />);
  await fireEvent.press(screen.getByText('Declined'));
  await fireEvent.press(screen.getByText('Pay'));
  await waitFor(() => expect(bugsee.logException).toHaveBeenCalledWith(expect.any(Error), {
    labels: ['checkout', 'payment'],
    domain: 'payment',
  }));
  expect(alert).toHaveBeenCalledWith('Checkout', 'Payment declined');
});

test('checkout bug schedules a TypeError from a timer', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.useFakeTimers();
  try {
    await render(<Checkout />);
    await fireEvent.press(screen.getByText('Bug'));
    await fireEvent.press(screen.getByText('Pay'));
    expect(() => jest.advanceTimersByTime(300)).toThrow(TypeError);
  } finally {
    jest.useRealTimers();
  }
});

test('sign-in shows an inline error and finishes the span with Error when the request rejects', async () => {
  global.fetch = jest.fn(async () => { throw new Error('offline'); }) as never;
  await render(<SignIn />);
  await fireEvent.press(screen.getByText('Sign in'));
  expect(await screen.findByText('Sign in failed: offline')).toBeTruthy();
  const tx = bugsee.startTransaction.mock.results[0].value;
  const span = tx.startChildSpan.mock.results[0].value;
  expect(span.finish).toHaveBeenCalledWith(SpanStatus.Error);
});

test('checkout Bug shows Processing, not success', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.useFakeTimers();
  try {
    await render(<Checkout />);
    await fireEvent.press(screen.getByText('Bug'));
    await fireEvent.press(screen.getByText('Pay'));
    expect(await screen.findByText('Processing…')).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
    expect(screen.queryByText('Order placed')).toBeNull();
    expect(() => jest.advanceTimersByTime(300)).toThrow(TypeError);
  } finally {
    jest.useRealTimers();
  }
});

test('products shows an inline error for a non-HTTP failure and clears it on the next load', async () => {
  const spy = jest.spyOn(demoApi, 'fetchProducts').mockRejectedValueOnce(new Error('boom'));
  await render(<Products />);
  expect(await screen.findByText('Could not load products: boom')).toBeTruthy();
  spy.mockResolvedValue({ products: productsBody.products, source: 'network' });
  await fireEvent(screen.getByLabelText('Flaky API (every 3rd load fails)'), 'valueChange', true);
  await waitFor(() => expect(screen.queryByText('Could not load products: boom')).toBeNull());
  spy.mockRestore();
});

test('layout sets the filter and starts the flow; unmount clears and cancels', async () => {
  const view = await render(<ShopLayout />);
  expect(bugsee.setNetworkFilter).toHaveBeenCalledWith(expect.any(Function));
  expect(bugsee.startTransaction).toHaveBeenCalledWith('checkout', 'shop.flow');
  const tx = bugsee.startTransaction.mock.results[0].value;
  await view.unmount();
  expect(bugsee.setNetworkFilter).toHaveBeenLastCalledWith(null);
  expect(tx.finish).toHaveBeenCalledWith(SpanStatus.Cancelled);
});

test('product detail reads the catalog Products loaded, without a refetch', async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, title: `Item ${i + 1}`, price: 1, description: 'd',
  }));
  demoApi.rememberCatalog(twelve);
  mockParams.id = '9';
  const spy = jest.spyOn(demoApi, 'fetchProducts');
  await render(<ProductDetail />);
  expect(await screen.findByText('Item 9')).toBeTruthy();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('products stores what it loaded for the detail screen', async () => {
  await render(<Products />);
  await screen.findByText('Widget');
  mockParams.id = '1';
  const spy = jest.spyOn(demoApi, 'fetchProducts');
  await render(<ProductDetail />);
  expect(await screen.findAllByText('Widget')).toBeTruthy();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('product detail shows Product not found with a back button when the id is in no catalog', async () => {
  const spy = jest.spyOn(demoApi, 'fetchProducts').mockResolvedValue({ products: [], source: 'mock' });
  mockParams.id = '11';
  await render(<ProductDetail />);
  expect(await screen.findByText('Product not found')).toBeTruthy();
  expect(screen.queryByText('Loading...')).toBeNull();
  await fireEvent.press(screen.getByText('Back to products'));
  expect(mockBack).toHaveBeenCalled();
  spy.mockRestore();
});

test('every shop TextInput sets the shared placeholder colour (readable whatever the system theme)', async () => {
  const { PLACEHOLDER_COLOR } = jest.requireActual('../src/ui/placeholder');
  for (const Ui of [SignIn, Checkout]) {
    const view = await render(<Ui />);
    const inputs = view.getAllByPlaceholderText(/.+/);
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.props.placeholderTextColor).toBe(PLACEHOLDER_COLOR);
    await view.unmount();
  }
});
