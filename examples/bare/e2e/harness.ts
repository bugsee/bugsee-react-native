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
import { writeFileSync } from 'node:fs';

import { checkLaunch, launchFactsOf, parseCampaignMode } from '../../../scripts/campaign-endpoint-guard';
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
  terminateIosApp,
} from './bundles';
import { ANDROID_PACKAGE, IOS_SIMULATOR_ID, iosDeviceId, iosTarget, verifyIosDevice } from './device';
import {
  type DeviceLog,
  IosConsole,
  type IosLaunch,
  type LogLine,
  Logcat,
  type Scenario,
  adb,
  awaitMetroServes,
  launchScenario,
  scenarioArgs,
  smokeRoot,
  writeScenario,
} from './scenario';

export const PLATFORM = process.env.E2E_PLATFORM;
export const ON_ANDROID = PLATFORM === 'android';
export const ON_IOS = PLATFORM === 'ios';
export const describeDevice = ON_ANDROID || ON_IOS ? describe : describe.skip;

/**
 * `E2E_STAGING=1` is the STAGING lane (a real token, exactly
 * https://apidev.bugsee.com); anything else is offline (the placeholder token
 * and the dead endpoint). Every launch is checked against it (`checkRun`).
 */
export const CAMPAIGN_MODE = parseCampaignMode(process.env.E2E_STAGING);

/** A Release build is installed (`E2E_RELEASE=1`): the MX-CFG-RELEASE runs. */
export const RELEASE = process.env.E2E_RELEASE === '1';

/**
 * `fn` (an `it` or `describe`, possibly already conditional), skipped under
 * `E2E_RELEASE=1` because the cases it opens were written for a Debug build
 * -- `reason` says why, and is printed when it skips. The Release-subset
 * audit (scripts/campaign-release-audit.ts, N-28) requires every Debug-only
 * assertion (`expect(run.dev).toBe(true)`) to sit inside one.
 */
export function debugOnly<T extends jest.It | jest.Describe>(fn: T, reason: string): T {
  if (!RELEASE) {
    return fn;
  }
  console.log(`RELEASE-AUDIT skipped under E2E_RELEASE=1: ${reason}`);
  return ((fn as unknown as { skip?: T }).skip ?? fn) as T;
}

/** What a suite's title calls the device it runs on. */
export const TARGET_NAME = ON_IOS
  ? iosTarget() === 'simulator'
    ? `the iOS simulator (${IOS_SIMULATOR_ID})`
    : `an iPhone (${iosDeviceId()})`
  : 'an Android handset';

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

/**
 * What the device's log daemon says it threw away: `chatty` collapsing
 * (`expire <n> lines`), a per-process quota (EMUI's `LOGS OVER PROC QUOTA`)
 * or a reader that fell behind (`lines were dropped`). Seen once on the
 * WOD_LX1 (Task 6.8): a marker that was plainly written never arrived, with
 * `log.tag.BugseeRN` at DEBUG adding about nine lines a second.
 */
export const LOG_DROPS = /\bchatty\b|expire \d+ lines?|LOGS OVER PROC QUOTA|lines? (were|was) dropped/i;

/**
 * Fails with the captured log, so a miss can be read rather than guessed --
 * and says whether the log itself dropped lines, since a line the device
 * never delivered reads exactly like one the app never wrote.
 */
export function must(line: LogLine | undefined, what: string, from = 0): LogLine {
  if (line === undefined) {
    const drops = log().all(LOG_DROPS, from).map(dropped => dropped.text.trim());
    const dropNote =
      drops.length === 0
        ? 'The device log reported no dropped lines.'
        : `The device log reported dropping lines (${drops.length}):\n${drops.slice(-20).join('\n')}`;
    throw new Error(`never saw ${what}.\n${dropNote}\nLog since the run started:\n${log().tail(from)}`);
  }
  return line;
}

/** Evidence surfaced for the commit body, tagged with the suite's task. */
export function report(label: string, value: unknown): void {
  console.log(`[${reportTag}] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/**
 * The platform's log for a suite, handed to the helpers here: logcat on
 * Android (tagged `androidTag`), the launched app's console on iOS (tagged
 * `iosTag`).
 */
export async function startDeviceLog(androidTag: string, iosTag: string): Promise<DeviceLog> {
  const log = ON_IOS ? IosConsole.start() : await Logcat.start();
  useLog(log, ON_IOS ? iosTag : androidTag);
  return log;
}

/**
 * Stops `log` and, when `E2E_LOGCAT_DUMP=<file>` is set, saves every line it
 * captured there (as report-handler.test.ts does), for reading a run after
 * the fact.
 */
export function stopDeviceLog(log: DeviceLog | undefined): void {
  if (log === undefined) {
    return;
  }
  log.stop();
  const dump = process.env.E2E_LOGCAT_DUMP;
  if (dump) {
    writeFileSync(dump, log.lines.map(line => line.text).join('\n'));
  }
}

/** Stops the app under test; not running is fine. */
export async function stopApp(): Promise<void> {
  if (ON_IOS) {
    await terminateIosApp();
  } else {
    await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
  }
}

/**
 * A line of the bridge's own log, `BugseeRN <rest>`: logcat's `BugseeRN:`
 * tag on Android, the `NSLog` text on iOS (`... BareExample[pid:tid]
 * BugseeRN <rest>`). `rest` is a regex source.
 */
export function bridgeLine(rest: string): RegExp {
  return new RegExp(ON_IOS ? `\\] BugseeRN ${rest}` : `BugseeRN\\s*:\\s*${rest}`);
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
  readonly launch?: IosLaunch;
}

/**
 * What every launch must show before a suite reads anything from it: the
 * campaign endpoint guard (N-30) on the app's own launch line -- offline,
 * the placeholder token against the dead endpoint; staging, a real token
 * against exactly the staging endpoint; production never -- and, under
 * `E2E_SMOKE_ROOT=1`, that the smoke root really ran. A refused launch stops
 * the app before the suite goes on.
 */
async function checkRun(ran: LogLine, start: number): Promise<void> {
  const facts = launchFactsOf(ran.text);
  const verdict =
    facts === undefined
      ? { ok: false, reason: "the app's launch line names no token kind and endpoint" }
      : checkLaunch(CAMPAIGN_MODE, facts);
  if (!verdict.ok) {
    await stopApp().catch(() => {});
    throw new Error(`campaign endpoint guard (N-30, ${CAMPAIGN_MODE} mode) refused this launch: ${verdict.reason}. The app was stopped.`);
  }
  if (smokeRoot()) {
    must(
      await log().waitFor(/BUGSEE_E2E launching on \w+ root=smoke/, 15_000, ran.index),
      'the smoke root (smoke/SmokeApp.tsx) launching, as E2E_SMOKE_ROOT=1 asks',
      start,
    );
  }
}

/** The SDK's version line on iOS, from the `NSLog` it prints at launch. */
export const IOS_SDK_LINE = /Bugsee IOS SDK ver:(\S+) build:(\S+)/;

/**
 * Starts the app on `name` and asserts the per-run preconditions: the app
 * really ran this scenario (the nonce round-trips), the SDK build is the
 * pinned one, and the SDK reached Launched with the device offline (Android)
 * or against a dead endpoint (iOS).
 */
export interface RunOptions {
  /** iOS: the HTTP stub's base URL for the app (stub-server.ts `deviceStubUrl`). */
  readonly stub?: string;
}

export async function startRun(name: string, options: RunOptions = {}): Promise<Run> {
  if (ON_IOS) {
    return startIosRun(name, options);
  }
  const scenario = writeScenario(name);
  if (smokeRoot()) {
    // The root is chosen from the JSON at bundle load (index.js), so Metro
    // must serve this run's file before the launch.
    await awaitMetroServes(scenario.nonce, 60_000, 'android');
  }
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
  await checkRun(ran, start);
  const launched = must(
    await log().waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
    'Status.Launched with the device offline',
    start,
  );
  return { scenario, start, banner, launched, dev: / dev=true/.test(ran.text) };
}

/**
 * The SDK's local refusal to start: once the server has rejected a token, the
 * iOS SDK stores it (`BugseeKilledSdkKey`, in the app's defaults) and refuses
 * every later launch with that token, before any network attempt -- whatever
 * the endpoint. The e2e's token is a placeholder the server rejects, so any
 * launch that reaches the real endpoint leaves the app in this state until
 * its container is wiped; every iOS launch the e2e makes therefore carries
 * DEAD_ENDPOINT (this file, and launch.test.ts).
 */
export const IOS_STOPPED_FOR_TOKEN = /Bugsee was stopped for current application token/;

/**
 * The iOS counterpart of `startRun`: the scenario carries the closed
 * loopback endpoint, since there is no airplane mode to switch, and the
 * retention precondition is the SDK failing to reach it rather than the
 * device being offline. The scenario and endpoint travel as launch arguments
 * (`scenarioArgs`), which reach the app whether it runs Metro's bundle or
 * its embedded one; the simulator, whose app always loads from Metro, also
 * waits for Metro to serve the new JSON.
 */
async function startIosRun(name: string, options: RunOptions): Promise<Run> {
  const ios = log() as IosConsole;
  // Staging launches against the credentials' endpoint, which the guard
  // (checkRun) requires to be exactly the staging one.
  const extras = {
    ...(CAMPAIGN_MODE === 'staging' ? {} : { endpoint: DEAD_ENDPOINT }),
    ...(options.stub === undefined ? {} : { stub: options.stub }),
  };
  const scenario = writeScenario(name, extras);
  if (iosTarget() === 'simulator') {
    await awaitMetroServes(scenario.nonce);
  } else {
    // The allowlisted iPhone, identity-checked, before its first launch.
    await verifyIosDevice();
  }
  const launch = ios.launch(scenarioArgs(scenario, extras));
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
  await checkRun(ran, start);
  const banner = must(await log().waitFor(IOS_SDK_LINE, 15_000, start), 'the iOS SDK version line', start);
  const version = IOS_SDK_LINE.exec(banner.text)![1];
  if (version !== readNativeVersions().ios.sdk) {
    throw new Error(`iOS SDK ${version} launched, but the pin is ${readNativeVersions().ios.sdk}`);
  }
  if (CAMPAIGN_MODE === 'staging') {
    const launched = must(
      await log().waitFor(/BUGSEE_E2E status=2/, 20_000, ran.index),
      'Status.Launched against the staging endpoint',
      start,
    );
    return { scenario, start, banner, launched, dev: / dev=true/.test(ran.text), launch };
  }
  const unreachable = must(
    await log().waitFor(
      new RegExp(`Session not initialized\\. - Could not connect to the server|${IOS_STOPPED_FOR_TOKEN.source}`),
      15_000,
      start,
    ),
    'the SDK failing to reach the dead endpoint',
    start,
  );
  if (IOS_STOPPED_FOR_TOKEN.test(unreachable.text)) {
    throw new Error(
      'the iOS SDK refuses to start: it holds a stopped flag for this token (BugseeKilledSdkKey), ' +
        'left by an earlier launch against the real endpoint. Wipe the app container ' +
        '(reinstall the app) and run again.\n' +
        `Log since the run started:\n${log().tail(start)}`,
    );
  }
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
