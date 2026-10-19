import { ActivityIndicator, Pressable, Text } from 'react-native';
import { Redirect, Tabs, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession } from '../../src/session/SessionContext';

type IconName = keyof typeof Ionicons.glyphMap;

// Without a tabBarIcon, React Navigation draws a fallback glyph that renders as an empty box on Android.
export const TABS: readonly (readonly [name: string, title: string, icon: IconName])[] = [
  ['index', 'Home', 'home-outline'],
  ['capture', 'Capture', 'videocam-outline'],
  ['privacy', 'Privacy', 'eye-off-outline'],
  ['errors', 'Errors', 'bug-outline'],
  ['reports', 'Reports', 'document-text-outline'],
  ['data', 'Data', 'server-outline'],
  ['perf', 'Perf', 'speedometer-outline'],
];

export default function TabsLayout() {
  const { ready, config } = useSession();
  const router = useRouter();
  if (!ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!config.everLaunched) return <Redirect href="/setup" />;
  return (
    <Tabs
      screenOptions={{
        headerRight: () => (
          <Pressable accessibilityRole="button" onPress={() => router.push('/setup')} style={{ paddingHorizontal: 12 }}>
            <Text>Setup</Text>
          </Pressable>
        ),
      }}
    >
      {TABS.map(([name, title, icon]) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{ title, tabBarIcon: ({ color, size }) => <Ionicons name={icon} color={color} size={size} /> }}
        />
      ))}
    </Tabs>
  );
}
