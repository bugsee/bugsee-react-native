import { createContext, useContext } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

export const ResultLogContext = createContext<(line: string) => void>(() => {});
export const useLog = () => useContext(ResultLogContext);

export function ResultLog({ lines }: { lines: string[] }) {
  return (
    <View style={styles.box} testID="result-log">
      <Text style={styles.title}>Result log</Text>
      {lines.slice(0, 50).map((l, i) => (
        <Text key={`${lines.length - i}`} style={styles.line}>{l}</Text>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, padding: 8, marginTop: 16 },
  title: { fontWeight: '700', marginBottom: 4 },
  line: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11 },
});
