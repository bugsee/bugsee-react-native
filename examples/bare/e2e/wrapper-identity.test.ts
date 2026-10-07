/**
 * API-45: the wrapper identity the SDK writes into a report.
 *
 * `launch()` registers the wrapper (`setWrapperInfo`) before the native
 * launch; both SDKs then put it under `environment.sdk.wrapper` in every
 * report: `type`, `version`, and a string context naming the React Native
 * version, the JS engine and the build configuration. Unit tests prove JS
 * builds that object; only a report proves it crossed and the SDK kept it.
 *
 * The expected values are read here from the packages on disk, not from the
 * app: `@bugsee/react-native`'s package.json version, the React Native the
 * example resolves, Hermes (the example's engine on both platforms), and
 * debug or release from the build the app reports it is (`dev=`).
 *
 * Scenario `cov-identity` (scenarios/coverage.ts) uploads one report.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PulledBundle } from './bundles';
import { type Run, TARGET_NAME, awaitBundles, describeDevice, must, report, startRun } from './harness';
import { beginRetainingSuite, endRetainingSuite } from './observe';
import { type DeviceLog } from './scenario';

jest.setTimeout(5 * 60_000);

function versionOf(packageJson: string): string {
  return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
}

const WRAPPER_VERSION = versionOf(join(__dirname, '..', '..', '..', 'packages', 'react-native', 'package.json'));
const REACT_NATIVE_VERSION = versionOf(require.resolve('react-native/package.json', { paths: [join(__dirname, '..')] }));

describeDevice(`the wrapper identity in a report on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;
  let run: Run;
  let bundle: PulledBundle;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-identity');
    run = await startRun('cov-identity');
    must(
      await log.waitFor(new RegExp(`BUGSEE_E2E cov identity uploaded nonce=${run.scenario.nonce}`), 20_000, run.start),
      'the identity report being uploaded',
      run.start,
    );
    const bundles = await awaitBundles(1);
    const mine = bundles.filter(b => b.request.summary === `cov-identity-${run.scenario.nonce}`);
    expect(mine).toHaveLength(1);
    bundle = mine[0]!;
  });

  afterAll(() => endRetainingSuite(log));

  it('names this wrapper, its version, React Native, Hermes and the build configuration', () => {
    const sdk = (bundle.request.environment as { sdk?: Record<string, unknown> }).sdk;
    report('environment.sdk.wrapper', sdk?.wrapper);
    expect(sdk?.wrapper).toEqual({
      type: 'react_native',
      version: WRAPPER_VERSION,
      context: {
        'react-native': REACT_NATIVE_VERSION,
        'js-engine': 'hermes',
        'build-configuration': run.dev ? 'debug' : 'release',
      },
    });
  });
});
