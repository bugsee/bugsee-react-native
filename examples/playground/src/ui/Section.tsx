import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  box: { marginTop: 16 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
});
