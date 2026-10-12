import { StyleSheet, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';
import { loggingActions } from './capture/loggingActions';
import { networkActions } from './capture/networkActions';

export const captureActions: Action[] = [...loggingActions, ...networkActions];

const WEBVIEW_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><p>Bugsee WebView demo</p><script>console.log('webview log'); fetch('https://httpbin.org/get?from=webview'); setTimeout(() => { throw new Error('webview error'); }, 500);</script></body></html>`;

const group = (prefixes: string[]) => captureActions.filter((a) => prefixes.some((p) => a.id.startsWith(p)));

export default function CaptureScreen() {
  return (
    <Screen title="Capture">
      <Section title="Logging">
        {group(['log-', 'console-', 'native-log']).map((a) => (
          <ActionButton key={a.id} action={a} />
        ))}
      </Section>
      <Section title="Network (JS)">
        {group(['net-'])
          .filter((a) => !a.id.startsWith('net-native') && a.id !== 'net-add-event')
          .map((a) => (
            <ActionButton key={a.id} action={a} />
          ))}
      </Section>
      <Section title="Network (native)">
        {group(['net-native']).map((a) => (
          <ActionButton key={a.id} action={a} />
        ))}
      </Section>
      <Section title="Network filters and events">
        <Text style={styles.note}>The demo shop installs its own filter while open and clears it on exit.</Text>
        {group(['nf-', 'net-add-event']).map((a) => (
          <ActionButton key={a.id} action={a} />
        ))}
      </Section>
      <Section title="WebView">
        <Text style={styles.note}>
          Expect: the WebView console line, its fetch, and the JS error in the report (with capture.webview.advanced
          on).
        </Text>
        <WebView source={{ html: WEBVIEW_HTML }} style={styles.web} originWhitelist={['*']} />
      </Section>
    </Screen>
  );
}
const styles = StyleSheet.create({ note: { marginBottom: 6 }, web: { height: 160 } });
