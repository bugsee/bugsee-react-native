import { Stack } from 'expo-router';
import { SessionProvider } from '../src/session/SessionProvider';
export default function Root() {
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
