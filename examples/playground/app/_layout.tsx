import Bugsee from '@bugsee/react-native';
import { Stack } from 'expo-router';
import { SessionProvider } from '../src/session/SessionProvider';

function RootLayout() {
  return (
    <SessionProvider>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="setup" options={{ title: 'Setup' }} />
        <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan app token' }} />
        <Stack.Screen name="shop" options={{ headerShown: false }} />
      </Stack>
    </SessionProvider>
  );
}

// Bugsee.wrap registers the view-tree anchor: without it the view hierarchy in reports is always empty.
// Expo Router has no registerComponent call to wrap, so the root layout itself is wrapped.
export default Bugsee.wrap(RootLayout);
