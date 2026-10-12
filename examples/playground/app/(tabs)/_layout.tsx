import { ActivityIndicator, Pressable, Text } from 'react-native';
import { Redirect, Tabs, useRouter } from 'expo-router';
import { useSession } from '../../src/session/SessionContext';

const TABS = [['index', 'Home'], ['capture', 'Capture'], ['privacy', 'Privacy'], ['errors', 'Errors'], ['reports', 'Reports'], ['data', 'Data'], ['perf', 'Perf']] as const;

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
      {TABS.map(([name, title]) => <Tabs.Screen key={name} name={name} options={{ title }} />)}
    </Tabs>
  );
}
