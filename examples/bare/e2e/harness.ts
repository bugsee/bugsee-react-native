/**
 * What every scenario-driven device suite does the same way: pick the
 * platform, fail with the captured log, start a scenario run and assert its
 * preconditions, and clear, list and pull the retained bundles.
 *
 * Shared by report-handler.test.ts, wrapper-channel.test.ts and
 * secure-rectangles.test.ts. State is per test file (Jest gives each file its
 * own module registry): a suite calls `useLog` once its log exists, and every
 * helper here reads that log.
 */
import { checkAndroidBanner } from '../../../scripts/sdk-banner';
import { readNativeVersions } from '../../../scripts/native-versions';
import {
  DEAD_ENDPOINT,
  type PulledBundle,
  clearAndroidBundles,
  clearIosBundles,
  listAndroidBundles,
  listIosBundles,
  pullAndroidBundles,
  pullIosBundles,
} from './bundles';
import {
  type DeviceLog,
  type LogLine,
  type Scenario,
  type SimulatorConsole,
  type SimulatorLaunch,
  awaitMetroServes,
  launchScenario,
  writeScenario,
} from './scenario';

export const PLATFORM = process.env.E2E_PLATFORM;
export const ON_ANDROID = PLATFORM === 'android';
export const ON_IOS = PLATFORM === 'ios';
export const describeDevice = ON_ANDROID || ON_IOS ? describe : describe.skip;

let current: DeviceLog | undefined;
let reportTag = 'e2e';

/**
 * Hands the suite's log to the helpers here, and names the task `report`
 * lines are tagged with.
 */
export function useLog(log: DeviceLog, tag: string): void {
  current = log;
  reportTag = tag;
}

function log(): DeviceLog {
  if (current === undefined) {
    throw new Error('e2e harness: call useLog(log, tag) before using the helpers');
  }
  return current;
}

/** Fails with the captured log, so a miss can be read rather than guessed. */
export function must(line: LogLine | undefined, what: string, from = 0): LogLine {
  if (line === undefined) {
    throw new Error(`never saw ${what}.\nLog since the run started:\n${log().tail(from)}`);
  }
  return line;
}

/** Evidence surfaced for the commit body, tagged with the suite's task. */
export function report(label: string, value: unknown): void {
  console.log(`[${reportTag}] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Run {
  readonly scenario: Scenario;
  /** Log index the run started at. */
  readonly start: number;
  readonly banner: LogLine;
  readonly launched: LogLine;
  /** Whether the JS bundle was built with __DEV__, as the app reports it. */
  readonly dev: boolean;
  /** iOS only: the launch's console attachment, which ends with the process. */
  readonly launch?: SimulatorLaunch;
}

/** The SDK's version line on iOS, from the `NSLog` it prints at launch. */
export const IOS_SDK_LINE = /Bugsee IOS SDK ver:(\S+) build:(\S+)/;

/**
 * Starts the app on `name` and asserts the per-run preconditions: the app
 * really ran this scenario (the nonce round-trips), the SDK build is the
 * pinned one, and the SDK reached Launched with the device offline (Android)
 * or against a dead endpoint (iOS).
 */
export async function startRun(name: string): Promise<Run> {
  if (ON_IOS) {
    return startIosRun(name);
  }
  const scenario = writeScenario(name);
  const start = log().mark();
  await launchScenario(scenario);

  const ran = must(
    await log().waitFor(
      new RegExp(`BUGSEE_E2E scenario=${name} nonce=${scenario.nonce} `),
      120_000,
      start,
    ),
    `the app starting scenario ${name} (nonce ${scenario.nonce})`,
    start,
  );
  const banner = must(
    await log().waitFor(/Bugsee Android SDK \S+ \[[0-9a-f]+\]/, 15_000, start),
    'the SDK build banner',
    start,
  );
  const bannerCheck = checkAndroidBanner(banner.text, readNativeVersions());
  if (!bannerCheck.ok) {
    throw new Error(`SDK build banner does not match the pin: ${bannerCheck.reason}`);
  }
  const launched = must(
    await log().waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
    'Status.Launched with the device offline',
    start,
  );
  return { scenario, start, banner, launched, dev: / dev=true/.test(ran.text) };
}

/**
 * The iOS counterpart of `startRun`: the scenario carries the closed
 * loopback endpoint, since the simulator has no airplane mode, and the
 * retention precondition is the SDK failing to reach it rather than the
 * device being offline.
 */
async function startIosRun(name: string): Promise<Run> {
  const simulator = log() as SimulatorConsole;
  const scenario = writeScenario(name, { endpoint: DEAD_ENDPOINT });
  await awaitMetroServes(scenario.nonce);
  const launch = simulator.launch();
  const { start } = launch;

  const ran = must(
    await log().waitFor(
      new RegExp(`BUGSEE_E2E scenario=${name} nonce=${scenario.nonce} `),
      120_000,
      start,
    ),
    `the app starting scenario ${name} (nonce ${scenario.nonce})`,
    start,
  );
  // The retention precondition, both halves: the app took the dead endpoint,
  // and the SDK really failed to reach it.
  expect(ran.text).toContain(`endpoint=${DEAD_ENDPOINT}`);
  const banner = must(await log().waitFor(IOS_SDK_LINE, 15_000, start), 'the iOS SDK version line', start);
  const version = IOS_SDK_LINE.exec(banner.text)![1];
  if (version !== readNativeVersions().ios.sdk) {
    throw new Error(`iOS SDK ${version} launched, but the pin is ${readNativeVersions().ios.sdk}`);
  }
  must(
    await log().waitFor(/Session not initialized\. - Could not connect to the server/, 15_000, start),
    'the SDK failing to reach the dead endpoint',
    start,
  );
  const launched = must(
    await log().waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
    'Status.Launched with the endpoint dead',
    start,
  );
  return { scenario, start, banner, launched, dev: / dev=true/.test(ran.text), launch };
}

export async function clearBundles(): Promise<void> {
  return ON_IOS ? clearIosBundles() : clearAndroidBundles();
}

export async function listBundles(): Promise<string[]> {
  return ON_IOS ? listIosBundles() : listAndroidBundles();
}

/**
 * The retained bundles, once at least `count` exist (or the wait runs out).
 * On iOS, which has no commit banner, each bundle's `environment.sdk` is the
 * build evidence: its version must be the pin.
 */
export async function awaitBundles(count: number, timeoutMs = 60_000): Promise<PulledBundle[]> {
  const deadline = Date.now() + timeoutMs;
  while ((await listBundles()).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (!ON_IOS) {
    return pullAndroidBundles();
  }
  const bundles = await pullIosBundles();
  for (const bundle of bundles) {
    const sdk = (bundle.request.environment as { sdk?: Record<string, unknown> } | undefined)?.sdk;
    report(`${bundle.file} environment.sdk`, { version: sdk?.version, build: sdk?.build, type: sdk?.type });
    expect(sdk?.version).toBe(readNativeVersions().ios.sdk);
  }
  return bundles;
}
