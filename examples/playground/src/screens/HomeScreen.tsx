import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import Bugsee, { Status } from '@bugsee/react-native';
import { useRouter } from 'expo-router';
import { loadConfig } from '../session/config';
import { launchWith, buildLaunchOptions } from '../session/launch';
import { useSession } from '../session/SessionContext';
import { ActionButton, describeError } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { useLog } from '../ui/ResultLog';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';
import { Toggle } from '../ui/Toggle';

export const homeActions: Action[] = [
  {
    id: 'launch',
    label: 'Launch',
    call: 'Bugsee.launch(token, options)',
    expect: 'Status goes Launching → Launched; resolves true',
    run: async () => launchWith(await loadConfig()),
  },
  {
    id: 'relaunch',
    label: 'Relaunch with saved options',
    call: 'Bugsee.relaunch(options)',
    expect: 'Lifecycle shows a stop and a new launch; new options in effect',
    run: async () => Bugsee.relaunch(buildLaunchOptions(await loadConfig(), Platform.OS as 'ios' | 'android')),
  },
  {
    id: 'stop',
    label: 'Stop',
    call: 'Bugsee.stop()',
    expect: 'Status → Stopped; resolves true',
    run: () => Bugsee.stop(),
  },
  {
    id: 'status',
    label: 'Get status',
    call: 'Bugsee.getStatus()',
    expect: '2 (Launched) after launch, 0 (Stopped) after stop',
    run: () => Bugsee.getStatus(),
  },
  {
    id: 'launch-options',
    label: 'Get launch options',
    call: 'Bugsee.getLaunchOptions()',
    expect: 'The options the SDK reports in effect',
    run: () => Bugsee.getLaunchOptions(),
  },
  {
    id: 'attach',
    label: 'Attach to a native auto-launch',
    call: 'Bugsee.attach()',
    expect:
      'Resolves; no second session. Only meaningful when the native side auto-launched (config plugin autoLaunch); the playground does not',
    run: () => Bugsee.attach(),
  },
  {
    id: 'delete-true-ios',
    label: 'Delete collected data (incl. intermediate)',
    call: 'Bugsee.deleteCollectedDataOnDevice(true)',
    expect: 'false while launched; true after Stop, and no old report is sent at the next launch',
    run: () => Bugsee.deleteCollectedDataOnDevice(true),
    platforms: ['ios'],
    knownIssue: 'cocoa-195',
  },
  {
    id: 'delete-true-android',
    label: 'Delete collected data (incl. intermediate)',
    call: 'Bugsee.deleteCollectedDataOnDevice(true)',
    expect: 'false while launched; true after Stop',
    run: () => Bugsee.deleteCollectedDataOnDevice(true),
    platforms: ['android'],
  },
  {
    id: 'delete-false-ios',
    label: 'Delete processed data only',
    call: 'Bugsee.deleteCollectedDataOnDevice(false)',
    expect: 'false while launched; true after Stop; intermediate capture kept',
    run: () => Bugsee.deleteCollectedDataOnDevice(false),
    platforms: ['ios'],
    knownIssue: 'cocoa-195',
  },
  {
    id: 'delete-false-android',
    label: 'Delete processed data only',
    call: 'Bugsee.deleteCollectedDataOnDevice(false)',
    expect: 'false while launched; true after Stop; intermediate capture kept',
    run: () => Bugsee.deleteCollectedDataOnDevice(false),
    platforms: ['android'],
    knownIssue: 'android-250',
  },
];
const statusName = (s: number) => Object.entries(Status).find(([, v]) => v === s)?.[0] ?? String(s);
const launchOptionsAction = homeActions.find((a) => a.id === 'launch-options')!;
const SESSION_IDS = new Set(['launch', 'relaunch', 'stop']);
const restActions = homeActions.filter((a) => !SESSION_IDS.has(a.id));

function SessionButton({ id, label, onPress }: { id: string; label: string; onPress: () => Promise<boolean> }) {
  const log = useLog();
  const call = homeActions.find((a) => a.id === id)!;
  const go = () => {
    log(`▶ ${label}`);
    onPress().then(
      (v) => log(`→ ${String(v)}`),
      (e) => log(`✗ ${describeError(e)}`),
    );
  };
  return (
    <Pressable accessibilityRole="button" onPress={go} style={styles.box} testID={`session-${id}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.call}>{call.call}</Text>
      <Text style={styles.expect}>{`Expect: ${call.expect}`}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const session = useSession();
  const router = useRouter();
  const [opts, setOpts] = useState<unknown>(undefined);
  const [optsError, setOptsError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const refresh = async () => {
    try {
      setOpts(await Bugsee.getLaunchOptions());
      setOptsError(null);
    } catch (e) {
      setOptsError(describeError(e));
    }
  };
  return (
    <Screen title="Home">
      <Section title="Status">
        <Text style={styles.status}>{statusName(session.status)}</Text>
        {session.lifecycle.length === 0 ? <Text style={styles.muted}>No lifecycle events yet</Text> : null}
        {[...session.lifecycle].reverse().map((l, i) => (
          <Text key={`${l.at}-${i}`} style={styles.mono}>{`${l.at} ${l.event}`}</Text>
        ))}
      </Section>
      <Section title="Session">
        <SessionButton id="launch" label="Launch" onPress={session.launch} />
        <SessionButton id="relaunch" label="Relaunch with saved options" onPress={session.relaunch} />
        <SessionButton id="stop" label="Stop" onPress={session.stop} />
        {restActions
          .filter((a) => !a.id.startsWith('delete-') && a.id !== 'launch-options')
          .map((a) => (
            <ActionButton key={a.id} action={a} />
          ))}
      </Section>
      <Section title="Launch options">
        <Pressable accessibilityRole="button" onPress={refresh} style={styles.box}>
          <Text style={styles.label}>Refresh launch options</Text>
          <Text style={styles.call}>{launchOptionsAction.call}</Text>
          <Text style={styles.expect}>{`Expect: ${launchOptionsAction.expect}`}</Text>
        </Pressable>
        {optsError ? <Text style={styles.error}>{optsError}</Text> : null}
        {opts !== undefined ? <Text style={styles.mono}>{JSON.stringify(opts, null, 2)}</Text> : null}
      </Section>
      <Section title="Data deletion">
        {restActions
          .filter((a) => a.id.startsWith('delete-'))
          .map((a) => (
            <ActionButton key={a.id} action={a} />
          ))}
      </Section>
      <Section title="Auto-launch">
        <Toggle
          label="Auto-launch on app start"
          value={session.config.autoLaunch}
          onChange={(v) => {
            setAutoError(null);
            session.setConfig({ ...session.config, autoLaunch: v }).catch((e) => setAutoError(describeError(e)));
          }}
        />
        {autoError ? <Text style={styles.error}>{`Could not save: ${autoError}`}</Text> : null}
      </Section>
      <Section title="Demo shop">
        <Pressable accessibilityRole="button" onPress={() => router.push('/shop/sign-in')} style={styles.box}>
          <Text style={styles.label}>Try the demo shop</Text>
          <Text style={styles.expect}>A small app to exercise Bugsee on realistic screens</Text>
        </Pressable>
      </Section>
    </Screen>
  );
}
const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
const styles = StyleSheet.create({
  status: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  muted: { color: '#667085' },
  mono: { fontFamily: mono, fontSize: 12 },
  error: { color: '#b42318' },
  box: { padding: 12, marginVertical: 4, borderRadius: 8, backgroundColor: '#f2f4f7' },
  label: { fontSize: 16, fontWeight: '600' },
  call: { fontFamily: mono, fontSize: 12, marginTop: 4 },
  expect: { fontSize: 12, color: '#475467', marginTop: 4 },
});
