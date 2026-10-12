import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { LogLevel } from '@bugsee/react-native';
import { AdvancedEditor } from '../options/AdvancedEditor';
import type { CommonOptions } from '../options/common';
import { useSession } from '../session/SessionContext';
import { isAppToken, tokenPrefix } from '../session/token';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';
import { Toggle } from '../ui/Toggle';

const ENDPOINT_RE = /^https:\/\/[^\s/?#@]+(:\d+)?(\/[^\s?#]*)?$/;
export const isValidEndpoint = (e: string) => e === '' || (ENDPOINT_RE.test(e) && !e.endsWith('/v2'));
const BOOLS = [
  ['video', 'Capture video'], ['network', 'Capture network'], ['logs', 'Capture logs'], ['breadcrumbs', 'Capture breadcrumbs'],
  ['crash', 'Detect crashes'], ['hang', 'Detect hangs'], ['wifiOnly', 'Upload on Wi-Fi only'],
] as const;
const LEVELS = [['Error', LogLevel.Error], ['Warning', LogLevel.Warning], ['Info', LogLevel.Info], ['Debug', LogLevel.Debug], ['Verbose', LogLevel.Verbose]] as const;
const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);

export default function SetupScreen() {
  const session = useSession();
  const router = useRouter();
  const platform = Platform.OS as 'ios' | 'android';
  const [token, setToken] = useState(session.config.token);
  const [endpoint, setEndpoint] = useState(session.config.endpoint);
  const [common, setCommon] = useState<CommonOptions>(session.config.common);
  const [advanced, setAdvanced] = useState(session.config.advanced);
  const [autoLaunch, setAutoLaunch] = useState(session.config.autoLaunch);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The saved config arrives asynchronously; adopt it once, when the session becomes ready.
    if (!session.ready) return;
    setToken(session.config.token); setEndpoint(session.config.endpoint); setCommon(session.config.common);
    setAdvanced(session.config.advanced); setAutoLaunch(session.config.autoLaunch);
  }, [session.ready]);
  const { pendingToken, setPendingToken } = session;
  useEffect(() => {
    if (pendingToken) { setToken(pendingToken); setPendingToken(null); }
  }, [pendingToken, setPendingToken]);

  const extra = Constants.expoConfig?.extra as { bugseeTokenPrefix?: Record<string, string> } | undefined;
  const buildPrefix = extra?.bugseeTokenPrefix?.[platform];
  const tokenOk = isAppToken(token);
  const endpointOk = isValidEndpoint(endpoint.trim());
  const mismatch = !!buildPrefix && tokenOk && tokenPrefix(token) !== buildPrefix.toLowerCase();
  const setC = <K extends keyof CommonOptions>(k: K, v: CommonOptions[K]) => setCommon((c) => ({ ...c, [k]: v }));

  const onLaunch = async () => {
    setBusy(true);
    try {
      await session.setConfig({ ...session.config, token: token.trim(), endpoint: endpoint.trim(), common, advanced, autoLaunch, everLaunched: true });
      await session.launch();
      router.replace('/(tabs)');
    } finally { setBusy(false); }
  };
  const disabled = !tokenOk || !endpointOk || busy;

  return (
    <Screen title="Setup" banner={false}>
      <Section title={`App token for ${platform === 'ios' ? 'iOS' : 'Android'}`}>
        <TextInput style={styles.input} placeholder="App token" autoCapitalize="none" autoCorrect={false} value={token} onChangeText={setToken} />
        {token !== '' && !tokenOk ? <Text style={styles.error}>Must be a UUID</Text> : null}
        {token === '' && buildPrefix ? <Text style={styles.hint}>{`Build-time token configured: ${buildPrefix}…; paste the full token`}</Text> : null}
        {mismatch ? (
          <Text style={styles.warn}>{`Symbols were uploaded for app ${buildPrefix}…. You're launching with ${tokenPrefix(token).slice(0, 4)}…, so crashes won't be symbolicated.`}</Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => router.push('/scan')} style={styles.link}><Text style={styles.linkText}>Scan QR</Text></Pressable>
      </Section>
      <Section title="Endpoint">
        <TextInput style={styles.input} placeholder="Leave empty for Bugsee cloud" autoCapitalize="none" autoCorrect={false} keyboardType="url" value={endpoint} onChangeText={setEndpoint} />
        {endpointOk ? null : <Text style={styles.error}>Must be an https URL (no /v2)</Text>}
      </Section>
      <Section title="Common options">
        {BOOLS.map(([k, label]) => <Toggle key={k} label={label} value={common[k]} onChange={(v) => setC(k, v)} />)}
        <Text style={styles.label}>Log level</Text>
        <Text style={styles.chips}>
          {LEVELS.map(([name, lv]) => (
            <Text key={name} accessibilityRole="button" onPress={() => setC('logLevel', lv)} style={[styles.chip, common.logLevel === lv && styles.chipOn]}>{` ${name} `}</Text>
          ))}
        </Text>
        <Text style={styles.label}>Duration (seconds)</Text>
        <TextInput style={styles.input} keyboardType="numeric" placeholder="unset" value={common.duration === undefined ? '' : String(common.duration)} onChangeText={(s) => setC('duration', num(s))} />
        <Text style={styles.label}>Max data size</Text>
        <TextInput style={styles.input} keyboardType="numeric" placeholder="unset" value={common.maxDataSize === undefined ? '' : String(common.maxDataSize)} onChangeText={(s) => setC('maxDataSize', num(s))} />
      </Section>
      <Section title="Advanced options"><AdvancedEditor values={advanced} onChange={setAdvanced} /></Section>
      <Section title="Auto-launch"><Toggle label="Launch on next app start" value={autoLaunch} onChange={setAutoLaunch} /></Section>
      <Pressable accessibilityRole="button" accessibilityLabel="Launch" accessibilityState={{ disabled }} disabled={disabled} onPress={onLaunch} style={[styles.launch, disabled && styles.off]}>
        <Text style={styles.launchText}>Launch</Text>
      </Pressable>
    </Screen>
  );
}
const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 6, padding: 8, fontSize: 14 },
  error: { color: '#b42318', fontSize: 12, marginTop: 4 },
  hint: { color: '#475467', fontSize: 12, marginTop: 4 },
  warn: { color: '#93370d', backgroundColor: '#fef0c7', fontSize: 12, padding: 8, borderRadius: 6, marginTop: 6 },
  link: { paddingVertical: 8 },
  linkText: { color: '#175cd3', fontSize: 15 },
  label: { fontSize: 13, marginTop: 8, marginBottom: 2, color: '#475467' },
  chips: { marginVertical: 4 },
  chip: { fontSize: 14, color: '#175cd3' },
  chipOn: { fontWeight: '700', backgroundColor: '#d1e0ff' },
  launch: { marginTop: 24, padding: 14, borderRadius: 8, backgroundColor: '#175cd3', alignItems: 'center' },
  off: { opacity: 0.4 },
  launchText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
