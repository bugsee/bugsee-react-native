import Bugsee, { SpanStatus } from '@bugsee/react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { addToCart, cart, finishFlow, resetCart } from '../src/shop/flow';
import Checkout from '../src/screens/shop/Checkout';
import ProductDetail from '../src/screens/shop/ProductDetail';
import Products from '../src/screens/shop/Products';
import SignIn from '../src/screens/shop/SignIn';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: '1' }),
}));

const bugsee = Bugsee as unknown as Record<string, jest.Mock>;
const productsBody = { products: [{ id: 1, title: 'Widget', price: 9.5, description: 'A widget' }] };

beforeEach(() => {
  jest.clearAllMocks();
  finishFlow(SpanStatus.OK);
  resetCart();
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => productsBody,
    text: async () => '{}',
  })) as never;
});

test('sign-in renders and submits', async () => {
  await render(<SignIn />);
  await fireEvent(screen.getByLabelText('Remember me'), 'valueChange', true);
  await fireEvent.press(screen.getByText('Sign in'));
  await waitFor(() => expect(bugsee.setUserIdentifier).toHaveBeenCalledWith('shopper@example.com'));
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
