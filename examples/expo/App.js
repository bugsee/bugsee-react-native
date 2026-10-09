/**
 * The Expo example (N-20): launches Bugsee and prints the markers the device
 * e2e and scripts/campaign/launch-check.sh read, as examples/bare does:
 *
 *   BUGSEE_E2E launching on <os> rn=<x.y.z> engine=<hermes|jsc> scenario=<name>
 *   BUGSEE_E2E status=<n> (<name>)
 *
 * Credentials: campaign-config.json beside this file, which holds only the
 * placeholder token and the dead endpoint. Never a real token.
 *
 * The scenario comes from the e2e deep link
 * `bugsee-e2e://scenario/<name>?nonce=<hex>` (app.json `scheme`), the channel
 * examples/bare uses on Android. `launch` is the default. The N-01 smoke
 * scenarios register in SCENARIOS below (additive edits only).
 */
/* global setInterval, clearInterval */
const React = require('react');
const { Linking, Platform, Text, View } = require('react-native');
const Bugsee = require('@bugsee/react-native');

const { default: bugsee, BugseeLaunchOptions, Status, createDefaultLaunchOptions } = Bugsee;

const config = require('./campaign-config.json');

const STATUS_NAMES = {
  [Status.Stopped]: 'Stopped',
  [Status.Launching]: 'Launching',
  [Status.Launched]: 'Launched',
  [Status.Stopping]: 'Stopping',
};

/** Scenario name -> async (nonce) => void, run once Launched. */
const SCENARIOS = {
  launch: async () => undefined,
};

const SCENARIO_URI = /^bugsee-e2e:\/\/scenario\/([\w-]+)\?nonce=([0-9a-f]+)/;

async function chooseScenario() {
  const uri = await Linking.getInitialURL().catch(() => null);
  const match = uri == null ? null : SCENARIO_URI.exec(uri);
  return match ? { scenario: match[1], nonce: match[2] } : { scenario: 'launch', nonce: '-' };
}

function engine() {
  return globalThis.HermesInternal ? 'hermes' : 'jsc';
}

function App() {
  const [status, setStatus] = React.useState(Status.Stopped);

  React.useEffect(() => {
    let last = -1;
    let cancelled = false;
    const poll = setInterval(() => {
      bugsee
        .getStatus()
        .then((next) => {
          if (!cancelled && next !== last) {
            last = next;
            setStatus(next);
            console.log(`BUGSEE_E2E status=${next} (${STATUS_NAMES[next]})`);
          }
        })
        .catch(() => undefined);
    }, 100);

    (async () => {
      const { scenario, nonce } = await chooseScenario();
      const rn = Platform.constants.reactNativeVersion;
      console.log(
        `BUGSEE_E2E launching on ${Platform.OS} rn=${rn.major}.${rn.minor}.${rn.patch} ` +
          `engine=${engine()} scenario=${scenario}`,
      );
      const options = createDefaultLaunchOptions();
      options.endpoint = config.endpoint;
      const token = Platform.OS === 'ios' ? config.ios : config.android;
      try {
        const ok = await bugsee.launch(token, BugseeLaunchOptions.serialize(options));
        console.log(`BUGSEE_E2E launch() resolved ${ok}`);
      } catch (e) {
        console.log(`BUGSEE_E2E launch() rejected ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const run = SCENARIOS[scenario];
      if (run === undefined) {
        console.log(`BUGSEE_E2E unknown scenario ${scenario}`);
        return;
      }
      await run(nonce);
      console.log(`BUGSEE_E2E scenario ${scenario} done nonce=${nonce}`);
    })();

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  return React.createElement(
    View,
    { style: { flex: 1, alignItems: 'center', justifyContent: 'center' } },
    React.createElement(Text, null, `Bugsee Expo: ${STATUS_NAMES[status]}`),
  );
}

module.exports = App;
