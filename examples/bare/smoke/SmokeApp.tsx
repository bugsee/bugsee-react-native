/**
 * The root component of an app generated for the beta campaign (N-01): it
 * speaks the e2e's protocol exactly as examples/bare's App.tsx does, and runs
 * only the smoke set (./scenarios.tsx), so e2e/smoke.test.ts drives any app
 * that registers it.
 *
 * What the e2e relies on, the same lines App.tsx prints:
 *   BUGSEE_E2E scenario=<s> nonce=<n> source=<uri|args|json> dev=<b> token=<placeholder|set> endpoint=<e>
 *   BUGSEE_E2E status=<n> (<name>)          on every status change
 * and the same three scenario channels: the Android launch URI
 * `bugsee-e2e://scenario/<s>?nonce=<n>[&endpoint=<url>]`, the iOS launch
 * arguments `-bugseeE2eScenario <s> -bugseeE2eNonce <n> [-bugseeE2eEndpoint
 * <url>]`, else e2e-scenario.json.
 *
 * Wiring in a generated app (the copy is `smoke/` plus `endpoint.ts` at the
 * app root, and the two JSON files scripts/write-credentials.mjs writes):
 *
 *   // index.js
 *   import { AppRegistry } from 'react-native';
 *   import Bugsee from '@bugsee/react-native';
 *   import { createSmokeApp } from './smoke/SmokeApp';
 *   import credentials from './credentials.json';
 *   import scenarioFile from './e2e-scenario.json';
 *   import { name } from './app.json';
 *   AppRegistry.registerComponent(name, () => Bugsee.wrap(createSmokeApp(credentials, scenarioFile)));
 *
 * A placeholder token never reaches a real server (endpoint.ts): the launch
 * goes to the dead loopback endpoint whatever was asked for.
 */
import { useEffect, useState } from 'react';
import { Linking, Platform, Settings, StyleSheet, Text, View } from 'react-native';
import Bugsee, {
  BugseeLaunchOptions,
  Status,
  createDefaultLaunchOptions,
  type LaunchOptions,
} from '@bugsee/react-native';

import { DEAD_ENDPOINT, isPlaceholderToken, launchEndpoint } from '../endpoint';
import {
  SmokeStage,
  type SmokeStageScenario,
  isSmokeScenario,
  isSmokeStageScenario,
  runSmokeScenario,
} from './scenarios';

export interface SmokeCredentials {
  readonly ios: string;
  readonly android: string;
  readonly endpoint: string;
}

export interface SmokeScenarioFile {
  readonly scenario: string;
  readonly nonce?: string;
  readonly endpoint?: string;
}

interface Choice {
  scenario: string;
  nonce: string;
  source: 'uri' | 'args' | 'json';
  endpoint?: string;
}

const STATUS_NAMES: Record<number, string> = {
  [Status.Stopped]: 'Stopped',
  [Status.Launching]: 'Launching',
  [Status.Launched]: 'Launched',
  [Status.Stopping]: 'Stopping',
};

const SCENARIO_URI = /^bugsee-e2e:\/\/scenario\/([\w-]+)\?nonce=([0-9a-f]+)(?:&endpoint=([\w%.-]+))?$/;

/** The scenario this launch runs: launch URI, else launch arguments, else the JSON. */
export async function chooseSmokeScenario(file: SmokeScenarioFile): Promise<Choice> {
  const uri = await Linking.getInitialURL().catch(() => null);
  const match = uri === null ? null : SCENARIO_URI.exec(uri);
  if (match !== null) {
    return {
      scenario: match[1]!,
      nonce: match[2]!,
      source: 'uri',
      endpoint: match[3] === undefined ? undefined : decodeURIComponent(match[3]),
    };
  }
  if (Platform.OS === 'ios') {
    const scenario: unknown = Settings.get('bugseeE2eScenario');
    const nonce: unknown = Settings.get('bugseeE2eNonce');
    const endpoint: unknown = Settings.get('bugseeE2eEndpoint');
    if (
      typeof scenario === 'string' &&
      typeof nonce === 'string' &&
      /^[\w-]+$/.test(scenario) &&
      /^[0-9a-f]+$/.test(nonce)
    ) {
      return {
        scenario,
        nonce,
        source: 'args',
        endpoint: typeof endpoint === 'string' && /^https?:\/\/\S+$/.test(endpoint) ? endpoint : undefined,
      };
    }
  }
  return { scenario: file.scenario, nonce: file.nonce ?? '-', source: 'json', endpoint: file.endpoint };
}

/** A root component bound to this app's credentials and scenario file. */
export function createSmokeApp(credentials: SmokeCredentials, scenarioFile: SmokeScenarioFile) {
  return function SmokeApp() {
    const [status, setStatus] = useState<number>(Status.Stopped);
    const [stage, setStage] = useState<{ scenario: SmokeStageScenario; nonce: string } | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
      let cancelled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      let announce: () => void = () => {};
      const launched = new Promise<void>(resolve => {
        announce = resolve;
      });
      const observe = (next: number) => {
        if (cancelled) {
          return;
        }
        setStatus(previous => {
          if (previous !== next) {
            console.log(`BUGSEE_E2E status=${next} (${STATUS_NAMES[next]})`);
            if (next === Status.Launched) {
              setTimeout(announce, 0);
            }
          }
          return next;
        });
      };

      (async () => {
        const token = Platform.OS === 'ios' ? credentials.ios : credentials.android;
        if (!token) {
          setError(`no ${Platform.OS} token: run scripts/write-credentials.mjs`);
          return;
        }
        const choice = await chooseSmokeScenario(scenarioFile);
        const { endpoint, forced } = launchEndpoint(token, choice.endpoint, credentials.endpoint);
        console.log(
          `BUGSEE_E2E scenario=${choice.scenario} nonce=${choice.nonce} ` +
            `source=${choice.source} dev=${String(__DEV__)} ` +
            `token=${isPlaceholderToken(token) ? 'placeholder' : 'set'} ` +
            `endpoint=${endpoint === '' ? 'default' : endpoint}`,
        );
        if (forced) {
          console.log(`BUGSEE_E2E placeholder token: launching against ${DEAD_ENDPOINT}`);
        }
        console.log(`BUGSEE_E2E launching on ${Platform.OS} root=smoke`);
        poll = setInterval(() => {
          Bugsee.getStatus().then(observe).catch(() => {});
        }, 100);
        const options = createDefaultLaunchOptions();
        options.endpoint = endpoint;
        try {
          const result = await Bugsee.launch(token, BugseeLaunchOptions.serialize(options) as LaunchOptions);
          console.log(`BUGSEE_E2E launch() resolved ${String(result)}`);
          await launched;
          if (!isSmokeScenario(choice.scenario)) {
            console.log(`BUGSEE_E2E smoke unknown scenario ${choice.scenario}`);
            return;
          }
          if (isSmokeStageScenario(choice.scenario)) {
            if (!cancelled) {
              setStage({ scenario: choice.scenario, nonce: choice.nonce });
            }
            return;
          }
          await runSmokeScenario(choice.scenario, choice.nonce);
        } catch (cause) {
          console.log(`BUGSEE_E2E launch() threw ${String(cause)}`);
          if (!cancelled) {
            setError(String(cause));
          }
        }
      })();

      return () => {
        cancelled = true;
        if (poll !== undefined) {
          clearInterval(poll);
        }
      };
    }, []);

    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Bugsee smoke</Text>
        <Text testID="status" style={styles.status}>
          {STATUS_NAMES[status] ?? `unknown (${status})`}
        </Text>
        {error !== undefined && <Text style={styles.error}>{error}</Text>}
        {stage !== undefined && <SmokeStage scenario={stage.scenario} nonce={stage.nonce} />}
      </View>
    );
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#11131a', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#8a94a6', fontSize: 16, marginBottom: 24 },
  status: { color: '#f5f7fa', fontSize: 40, fontWeight: '600' },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 24, textAlign: 'center' },
});
