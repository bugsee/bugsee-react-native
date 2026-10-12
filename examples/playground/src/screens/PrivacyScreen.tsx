import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Bugsee, { BugseeSecure } from '@bugsee/react-native';
import { NativeSecureField } from '../../modules/playground-native';
import { loadConfig } from '../session/config';
import { launchWith } from '../session/launch';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';
import { Toggle } from '../ui/Toggle';

// Actions are module-level, so the red overlay lives in a tiny subscribable store
// that the screen listens to; the setSecureRectangles actions update it.
type Rect = { x: number; y: number; width: number; height: number };
let overlayRects: Rect[] = [];
const overlayListeners = new Set<(r: Rect[]) => void>();
function setOverlay(r: Rect[]) {
  overlayRects = r;
  overlayListeners.forEach((l) => l(r));
}
const MANUAL_RECT: Rect = { x: 20, y: 200, width: 200, height: 80 };

export const privacyActions: Action[] = [
  { id: 'blackout-start', label: 'Start blackout', call: 'Bugsee.startBlackout()', expect: 'Video frames black and touches not recorded until endBlackout', run: () => Bugsee.startBlackout() },
  { id: 'blackout-end', label: 'End blackout', call: 'Bugsee.endBlackout()', expect: 'Video and touches recorded again', run: () => Bugsee.endBlackout() },
  { id: 'blackout-is', label: 'Is blackout', call: 'Bugsee.isBlackout()', expect: 'true between start and end, false otherwise', run: () => Bugsee.isBlackout() },
  {
    id: 'blackout-before-launch', label: 'Blackout before launch', call: 'Bugsee.startBlackout() before launch',
    expect: 'The first seconds of video are black',
    run: async () => { await Bugsee.stop(); Bugsee.startBlackout(); return launchWith(await loadConfig()); },
    platforms: ['ios', 'android'], knownIssue: 'android-248',
  },
  {
    id: 'secure-rect-set', label: 'Set secure rectangle', call: 'Bugsee.setSecureRectangles([{ x: 20, y: 200, width: 200, height: 80 }])',
    expect: 'The outlined area is black in the video',
    run: () => { Bugsee.setSecureRectangles([MANUAL_RECT]); setOverlay([MANUAL_RECT]); },
  },
  {
    id: 'secure-rect-clear', label: 'Clear secure rectangles', call: 'Bugsee.setSecureRectangles([])',
    expect: 'The outlined area is visible in the video again',
    run: () => { Bugsee.setSecureRectangles([]); setOverlay([]); },
  },
];

const byId = (...ids: string[]) => privacyActions.filter((a) => ids.includes(a.id));

export default function PrivacyScreen() {
  const [secure, setSecure] = useState(true);
  const [rects, setRects] = useState<Rect[]>(overlayRects);
  useEffect(() => {
    overlayListeners.add(setRects);
    return () => { overlayListeners.delete(setRects); };
  }, []);
  return (
    <View style={styles.root}>
      <Screen title="Privacy">
        <Section title="Blackout">
          {byId('blackout-start', 'blackout-end', 'blackout-is').map((a) => <ActionButton key={a.id} action={a} />)}
        </Section>
        <Section title="Blackout before launch">
          {byId('blackout-before-launch').map((a) => <ActionButton key={a.id} action={a} />)}
        </Section>
        <Section title="BugseeSecure">
          <Toggle label="BugseeSecure enabled" value={secure} onChange={setSecure} />
          <BugseeSecure enabled={secure}>
            <View style={styles.box}><Text style={styles.boxText}>This box is redacted</Text></View>
          </BugseeSecure>
          <Text style={styles.note}>Expect: a black rectangle over the box in the video while enabled</Text>
        </Section>
        <Section title="Secure TextInput">
          <TextInput style={styles.input} placeholder="Password" secureTextEntry />
          <BugseeSecure>
            <TextInput style={styles.input} placeholder="Card number" keyboardType="number-pad" />
          </BugseeSecure>
          <TextInput style={styles.input} placeholder="Plain field" />
          <Text style={styles.note}>Expect: password and card hidden in video; plain field visible</Text>
        </Section>
        <Section title="Manual rectangles">
          {byId('secure-rect-set', 'secure-rect-clear').map((a) => <ActionButton key={a.id} action={a} />)}
        </Section>
        <Section title="Native secure field">
          <NativeSecureField />
          <Text style={styles.note}>Expect: the native password field is hidden, and the plain one beside it is visible</Text>
        </Section>
      </Screen>
      {rects.map((r, i) => (
        <View key={i} pointerEvents="none" testID="secure-overlay" style={[styles.overlay, { left: r.x, top: r.y, width: r.width, height: r.height }]} />
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  box: { padding: 20, borderRadius: 8, backgroundColor: '#fdb022' },
  boxText: { fontSize: 16, fontWeight: '600' },
  note: { marginTop: 6, fontSize: 12, color: '#475467' },
  input: { borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, padding: 10, marginVertical: 4 },
  overlay: { position: 'absolute', borderWidth: 2, borderColor: '#d92d20' },
});
