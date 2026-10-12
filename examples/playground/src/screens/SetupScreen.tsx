import { Fragment, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { LogLevel, Status } from '@bugsee/react-native';
import { AdvancedEditor } from '../options/AdvancedEditor';
import type { CommonOptions } from '../options/common';
import { useSession } from '../session/SessionContext';
import { isAppToken, tokenPrefix } from '../session/token';
import { KnownIssue } from '../ui/KnownIssue';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';
import { Toggle } from '../ui/Toggle';

const ENDPOINT_RE = /^https:\/\/[^\s/?#@]+(:\d+)?(\/[^\s?#]*)?$/;
export const isValidEndpoint = (e: string) =>
  e === '' || (ENDPOINT_RE.test(e) && !e.replace(/\/+$/, '').endsWith('/v2'));
const BOOLS = [
  ['video', 'Capture video'],
  ['network', 'Capture network'],
  ['logs', 'Capture logs'],
  ['breadcrumbs', 'Capture breadcrumbs'],
  ['crash', 'Detect crashes'],
  ['hang', 'Detect hangs'],
  ['wifiOnly', 'Upload on Wi-Fi only'],
] as const;
const WHOLE_ERR = 'Must be a whole number ≥ 0';
const LEVELS = [
  ['Error', LogLevel.Error],
  ['Warning', LogLevel.Warning],
  ['Info', LogLevel.Info],
  ['Debug', LogLevel.Debug],
  ['Verbose', LogLevel.Verbose],
] as const;
const wholeOk = (s: string) => s.trim() === '' || /^\d+$/.test(s.trim());
const whole = (s: string) => (s.trim() === '' ? undefined : Number(s.trim()));
const text = (n?: number) => (n === undefined ? '' : String(n));
type Extra = { bugseeTokenPrefix?: Record<string, string>; bugseeEndpoint?: string } | undefined;
export const RELAUNCHED = 'Relaunched with the new options';

export default function SetupScreen() {
  const session = useSession();
  const router = useRouter();
  const platform = Platform.OS as 'ios' | 'android';
  const extra = Constants.expoConfig?.extra as Extra;
  const buildEndpoint = extra?.bugseeEndpoint;
  // An empty saved endpoint launches against the build's own (bugsee.config.json), so show that value.
  const initialEndpoint = (saved: string) => (saved === '' && buildEndpoint ? buildEndpoint : saved);
  const [token, setToken] = useState(session.config.token);
  const [endpoint, setEndpoint] = useState(initialEndpoint(session.config.endpoint));
  const [common, setCommon] = useState<CommonOptions>(session.config.common);
  const [advanced, setAdvanced] = useState(session.config.advanced);
  const [autoLaunch, setAutoLaunch] = useState(session.config.autoLaunch);
  const [durationText, setDurationText] = useState(text(session.config.common.duration));
  const [maxText, setMaxText] = useState(text(session.config.common.maxDataSize));
  const [busy, setBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    // The saved config arrives asynchronously; adopt it once, when the session becomes ready.
    if (!session.ready) return;
    setToken(session.config.token);
    setEndpoint(initialEndpoint(session.config.endpoint));
    setCommon(session.config.common);
    setAdvanced(session.config.advanced);
    setAutoLaunch(session.config.autoLaunch);
    setDurationText(text(session.config.common.duration));
    setMaxText(text(session.config.common.maxDataSize));
  }, [session.ready]);
  const { pendingToken, setPendingToken } = session;
  useEffect(() => {
    if (pendingToken) {
      setToken(pendingToken);
      setPendingToken(null);
    }
  }, [pendingToken, setPendingToken]);

  const buildPrefix = extra?.bugseeTokenPrefix?.[platform];
  const tokenOk = isAppToken(token);
  const endpointOk = isValidEndpoint(endpoint.trim());
  const mismatch = !!buildPrefix && tokenOk && tokenPrefix(token) !== buildPrefix.toLowerCase();
  const setC = <K extends keyof CommonOptions>(k: K, v: CommonOptions[K]) => setCommon((c) => ({ ...c, [k]: v }));

  const numsOk = wholeOk(durationText) && wholeOk(maxText);
  const onLaunch = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setLaunchError(null);
    try {
      const edited = { ...common, duration: whole(durationText), maxDataSize: whole(maxText) };
      await session.setConfig({
        ...session.config,
        token: token.trim(),
        endpoint: endpoint.trim(),
        common: edited,
        advanced,
        autoLaunch,
      });
      // A running SDK ignores launch(), so stop it first: the new token and options then take effect.
      const running = session.status === Status.Launched || session.status === Status.Launching;
      if (running) await session.stop();
      if (await session.launch()) {
        if (running) session.note(RELAUNCHED);
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)');
      } else {
        setLaunchError('Bugsee did not launch (already running, or the token was rejected). See Home → lifecycle.');
      }
    } catch (e) {
      setLaunchError(`Launch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const disabled = !tokenOk || !endpointOk || !numsOk || busy;

  return (
    <Screen title="Setup" banner={false}>
      <Section title={`App token for ${platform === 'ios' ? 'iOS' : 'Android'}`}>
        <TextInput
          style={styles.input}
          placeholder="App token"
          autoCapitalize="none"
          autoCorrect={false}
          value={token}
          onChangeText={setToken}
        />
        {token !== '' && !tokenOk ? <Text style={styles.error}>Must be a UUID</Text> : null}
        {token === '' && buildPrefix ? (
          <Text style={styles.hint}>{`Build-time token configured: ${buildPrefix}…; paste the full token`}</Text>
        ) : null}
        {mismatch ? (
          <Text
            style={styles.warn}
          >{`Symbols were uploaded for app ${buildPrefix}…. You're launching with ${tokenPrefix(token).slice(0, 4)}…, so crashes won't be symbolicated.`}</Text>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => router.push('/scan')} style={styles.link}>
          <Text style={styles.linkText}>Scan QR</Text>
        </Pressable>
      </Section>
      <Section title="Endpoint">
        <TextInput
          style={styles.input}
          placeholder="Leave empty for the build's default (Bugsee cloud unless bugsee.config.json sets one)"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={endpoint}
          onChangeText={setEndpoint}
        />
        {endpointOk ? null : <Text style={styles.error}>Must be an https URL (no /v2)</Text>}
        {buildEndpoint && endpoint.trim() === buildEndpoint ? (
          <Text style={styles.hint}>From bugsee.config.json</Text>
        ) : null}
      </Section>
      <Section title="Common options">
        {BOOLS.map(([k, label]) => (
          <Fragment key={k}>
            <Toggle label={label} value={common[k]} onChange={(v) => setC(k, v)} />
            {k === 'video' ? <KnownIssue id="cocoa-196" /> : null}
          </Fragment>
        ))}
        <Text style={styles.label}>Log level</Text>
        <Text style={styles.chips}>
          {LEVELS.map(([name, lv]) => (
            <Text
              key={name}
              accessibilityRole="button"
              onPress={() => setC('logLevel', lv)}
              style={[styles.chip, common.logLevel === lv && styles.chipOn]}
            >{` ${name} `}</Text>
          ))}
        </Text>
        <Text style={styles.label}>Duration (seconds)</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          placeholder="unset"
          value={durationText}
          onChangeText={setDurationText}
          accessibilityLabel="Duration"
        />
        {wholeOk(durationText) ? null : <Text style={styles.error}>{WHOLE_ERR}</Text>}
        <Text style={styles.label}>Max data size</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          placeholder="unset"
          value={maxText}
          onChangeText={setMaxText}
          accessibilityLabel="Max data size"
        />
        {wholeOk(maxText) ? null : <Text style={styles.error}>{WHOLE_ERR}</Text>}
      </Section>
      <Section title="Advanced options">
        <AdvancedEditor values={advanced} onChange={setAdvanced} />
      </Section>
      <Section title="Auto-launch">
        <Toggle label="Launch on next app start" value={autoLaunch} onChange={setAutoLaunch} />
        <Text style={styles.hint}>Needed to send crash reports at the next start</Text>
      </Section>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Launch"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onLaunch}
        style={[styles.launch, disabled && styles.off]}
      >
        <Text style={styles.launchText}>Launch</Text>
      </Pressable>
      {launchError ? <Text style={styles.error}>{launchError}</Text> : null}
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
