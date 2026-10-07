/**
 * Launch check for a campaign-generated app (scripts/campaign/gen-rn-app.sh).
 *
 * Launches Bugsee with the placeholder token against the dead endpoint and
 * prints the same markers examples/bare prints, so the e2e harness and
 * scripts/campaign/launch-check.sh can read them from the device log:
 *
 *   BUGSEE_E2E launching on <platform> rn=<version> engine=<hermes|jsc>
 *   BUGSEE_E2E status=<n> (<name>)
 *
 * Replaced by the N-01 smoke module when gen-rn-app.sh is given --smoke.
 */
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Bugsee, {
  BugseeLaunchOptions,
  Status,
  createDefaultLaunchOptions,
} from '@bugsee/react-native';

import config from './campaign-config.json';

const STATUS_NAMES: Record<number, string> = {
  [Status.Stopped]: 'Stopped',
  [Status.Launching]: 'Launching',
  [Status.Launched]: 'Launched',
  [Status.Stopping]: 'Stopping',
};

function engine(): string {
  return (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'hermes' : 'jsc';
}

export default function App() {
  const [status, setStatus] = useState<number>(Status.Stopped);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let last = -1;
    const poll = setInterval(() => {
      Bugsee.getStatus()
        .then(next => {
          if (next !== last) {
            last = next;
            setStatus(next);
            console.log(`BUGSEE_E2E status=${next} (${STATUS_NAMES[next]})`);
          }
        })
        .catch(() => undefined);
    }, 100);

    const rn = Platform.constants.reactNativeVersion;
    console.log(
      `BUGSEE_E2E launching on ${Platform.OS} rn=${rn.major}.${rn.minor}.${rn.patch} engine=${engine()}`,
    );
    const options = createDefaultLaunchOptions();
    options.endpoint = config.endpoint;
    // The package README's `options.serialize()` does not exist: serialize is
    // static (README deviation R-1 in campaign-prep-build.md).
    const token = Platform.OS === 'ios' ? config.ios : config.android;
    Bugsee.launch(token, BugseeLaunchOptions.serialize(options))
      .then(ok => console.log(`BUGSEE_E2E launch() resolved ${ok}`))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`BUGSEE_E2E launch() rejected ${message}`);
        setError(message);
      });
    return () => clearInterval(poll);
  }, []);

  return (
    <View style={styles.root}>
      <Text testID="status">Bugsee status: {STATUS_NAMES[status]}</Text>
      {error === undefined ? null : <Text testID="error">{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
