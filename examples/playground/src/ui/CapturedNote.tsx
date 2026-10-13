import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** A collapsible "What Bugsee captured here" box. */
export function CapturedNote({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.box}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Text style={styles.title}>{open ? '▾' : '▸'} What Bugsee captured here</Text>
      </Pressable>
      {open ? lines.map((l) => <Text key={l} style={styles.line}>{`• ${l}`}</Text>) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  box: { marginTop: 16, padding: 12, borderRadius: 8, backgroundColor: '#eef3ff' },
  title: { fontWeight: '600' },
  line: { marginTop: 4, fontSize: 13 },
});
