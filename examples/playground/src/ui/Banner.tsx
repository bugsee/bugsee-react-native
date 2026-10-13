import { StyleSheet, Text, View } from 'react-native';
import { Status } from '@bugsee/react-native';
import { useOptionalSession } from '../session/SessionContext';

export function NotLaunchedBanner() {
  const session = useOptionalSession();
  if (!session || session.status === Status.Launched) return null;
  return (
    <View style={styles.bar} testID="not-launched-banner">
      <Text style={styles.text}>Bugsee not launched. Calls still run and show what they return.</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  bar: { backgroundColor: '#fef0c7', padding: 8, borderRadius: 6, marginBottom: 12 },
  text: { color: '#93370d', fontSize: 13 },
});
