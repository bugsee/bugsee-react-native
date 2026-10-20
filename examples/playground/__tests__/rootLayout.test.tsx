import { render } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import Bugsee from '@bugsee/react-native';
import RootLayout from '../app/_layout';

// Captured at import time, before any test could clear the mock's calls.
const wrap = Bugsee.wrap as unknown as jest.Mock;
const calls = [...wrap.mock.calls] as [ComponentType][];
const results = [...wrap.mock.results];

test('the root layout is exported through Bugsee.wrap, so the view hierarchy has an anchor', async () => {
  expect(calls).toHaveLength(1);
  expect(typeof calls[0][0]).toBe('function');
  expect(calls[0][0].name).toBe('RootLayout');
  expect(RootLayout).toBe(results[0].value);
  // Still a valid layout component (the mock wrap passes it through).
  await render(<RootLayout />);
});
