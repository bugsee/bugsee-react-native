import { useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { Action } from './action';
import { KnownIssue } from './KnownIssue';
import { useLog } from './ResultLog';

export function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    /* fall through */
  }
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    try {
      return `${e.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${e.message}`;
    } catch {
      return '[unprintable]';
    }
  }
  return describe(e);
}

// Many SDK calls return nothing (upload, log, startBlackout...): say "done" rather than a bare "undefined".
const describeResult = (v: unknown) =>
  v === undefined ? 'done (returns nothing)' : v instanceof Error ? describeError(v) : describe(v);

export function ActionButton({ action }: { action: Action }) {
  const log = useLog();
  // The screen's result log sits below every action, often off screen: echo the latest outcome on the card itself.
  const [last, setLast] = useState<string | undefined>(undefined);
  // The run that owns the card: a slow earlier run must not overwrite a later tap's outcome there.
  const latestRun = useRef(0);
  if (action.platforms && !action.platforms.includes(Platform.OS as 'ios' | 'android')) return null;
  // Every completion is logged; only the latest tap's outcome goes on the card.
  const report = (line: string, run: number) => {
    log(line);
    if (run === latestRun.current) setLast(line);
  };
  const go = () => {
    const run = ++latestRun.current;
    log(`▶ ${action.label}`);
    setLast('▶ running…');
    try {
      const r = action.run();
      if (typeof (r as { then?: unknown } | null | undefined)?.then === 'function') {
        Promise.resolve(r).then(
          (v) => report(`→ ${describeResult(v)}`, run),
          (e) => report(`✗ ${describeError(e)}`, run),
        );
      } else report(`→ ${describeResult(r)}`, run);
    } catch (e) {
      report(`✗ ${describeError(e)}`, run);
    }
  };
  const press = () =>
    action.confirm
      ? Alert.alert(action.label, action.confirm, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Crash', style: 'destructive', onPress: go },
        ])
      : go();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={press}
      android_ripple={{ color: '#d0d5dd' }}
      style={({ pressed }) => [styles.box, pressed && styles.pressed]}
      testID={`action-${action.id}`}
    >
      <Text style={styles.label}>{action.label}</Text>
      <Text style={styles.call}>{action.call}</Text>
      <Text style={styles.expect}>{`Expect: ${action.expect}`}</Text>
      {action.knownIssue ? <KnownIssue id={action.knownIssue} /> : null}
      {last !== undefined ? (
        <Text style={[styles.result, last.startsWith('✗') && styles.failed]} testID={`action-result-${action.id}`}>
          {last}
        </Text>
      ) : null}
    </Pressable>
  );
}
const styles = StyleSheet.create({
  box: { padding: 12, marginVertical: 4, borderRadius: 8, backgroundColor: '#f2f4f7', overflow: 'hidden' },
  pressed: { backgroundColor: '#e4e7ec' },
  label: { fontSize: 16, fontWeight: '600' },
  call: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginTop: 4 },
  expect: { fontSize: 12, color: '#475467', marginTop: 4 },
  result: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    color: '#067647',
    marginTop: 6,
  },
  failed: { color: '#b42318' },
});
