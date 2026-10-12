import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { Action } from './action';
import { KnownIssue } from './KnownIssue';
import { useLog } from './ResultLog';

export function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { /* fall through */ }
  try { return String(value); } catch { return '[unprintable]'; }
}
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    try { return `${e.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${e.message}`; } catch { return '[unprintable]'; }
  }
  return describe(e);
}

const describeResult = (v: unknown) => (v instanceof Error ? describeError(v) : describe(v));

export function ActionButton({ action }: { action: Action }) {
  const log = useLog();
  if (action.platforms && !action.platforms.includes(Platform.OS as 'ios' | 'android')) return null;
  const go = () => {
    log(`▶ ${action.label}`);
    try {
      const r = action.run();
      if (typeof (r as { then?: unknown } | null | undefined)?.then === 'function') {
        Promise.resolve(r).then((v) => log(`→ ${describeResult(v)}`), (e) => log(`✗ ${describeError(e)}`));
      } else log(`→ ${describeResult(r)}`);
    } catch (e) {
      log(`✗ ${describeError(e)}`);
    }
  };
  const press = () =>
    action.confirm
      ? Alert.alert(action.label, action.confirm, [{ text: 'Cancel', style: 'cancel' }, { text: 'Crash', style: 'destructive', onPress: go }])
      : go();
  return (
    <Pressable accessibilityRole="button" onPress={press} style={styles.box} testID={`action-${action.id}`}>
      <Text style={styles.label}>{action.label}</Text>
      <Text style={styles.call}>{action.call}</Text>
      <Text style={styles.expect}>{`Expect: ${action.expect}`}</Text>
      {action.knownIssue ? <KnownIssue id={action.knownIssue} /> : null}
    </Pressable>
  );
}
const styles = StyleSheet.create({
  box: { padding: 12, marginVertical: 4, borderRadius: 8, backgroundColor: '#f2f4f7' },
  label: { fontSize: 16, fontWeight: '600' },
  call: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginTop: 4 },
  expect: { fontSize: 12, color: '#475467', marginTop: 4 },
});
