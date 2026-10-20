import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ADVANCED_KEYS } from './advanced';
import { PLACEHOLDER_COLOR } from '../ui/placeholder';

const PREFIX = 'com.bugsee.option.';
const short = (k: string) => (k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k);

export function AdvancedEditor({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const set = (k: string, v: string) => {
    const next = { ...values };
    if (v === '') delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const keys = ADVANCED_KEYS.filter((k) => short(k).toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <View>
      <Pressable accessibilityRole="button" onPress={() => setOpen((o) => !o)}>
        <Text style={styles.toggle}>{open ? 'Hide options' : 'Show options'}</Text>
      </Pressable>
      {open ? (
        <View>
          <TextInput
            style={styles.input}
            placeholderTextColor={PLACEHOLDER_COLOR}
            placeholder="Filter options"
            autoCapitalize="none"
            autoCorrect={false}
            value={filter}
            onChangeText={setFilter}
          />
          {keys.map((k) => (
            <View key={k} style={styles.row}>
              <Text style={styles.key}>{short(k)}</Text>
              <TextInput
                style={[styles.input, styles.value]}
                placeholderTextColor={PLACEHOLDER_COLOR}
                placeholder="unset"
                autoCapitalize="none"
                autoCorrect={false}
                value={values[k] ?? ''}
                onChangeText={(v) => set(k, v)}
                accessibilityLabel={`Option ${short(k)}`}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  toggle: { fontSize: 15, paddingVertical: 8, color: '#175cd3' },
  input: { borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 6, padding: 8, fontSize: 14 },
  row: { marginTop: 8 },
  key: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginBottom: 2 },
  value: { marginTop: 2 },
});
