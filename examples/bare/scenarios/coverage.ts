/**
 * The beta-coverage scenarios: what the API/device-coverage matrix
 * (api-device-coverage.md) listed as automatable but unproven on a device.
 *
 *   cov-identity    one upload; the test reads the wrapper identity the SDK
 *                   wrote into the bundle's environment (API-45).
 *   cov-lifecycle   subscribes to onLifecycleEvent and onStatusChange before
 *                   launch(), uploads, waits for the report to be assembled,
 *                   then stops the SDK, uploads again (must be ignored) and
 *                   deletes the collected data (API-03, API-05, API-41,
 *                   FLOW-12).
 *   cov-apm         a transaction whose name, description and status are
 *                   changed after it starts, getActiveSpan(), and a child
 *                   span finished with a status (API-18, API-19).
 *   cov-jscrash     Bugsee.testJsCrash() thrown outside any try, so the
 *                   global handler reports it as a crash (API-10).
 *   cov-dialog-color  a report background color, then the report dialog,
 *                   which the test screenshots (API-40, FLOW-21).
 *   opt-<case>      launches with the option set `OPTION_CASES[<case>]`
 *                   names, does the same fixed work every case does, and
 *                   uploads (API-42, API-43, API-44). See launchOverrides.
 *
 * Every name, message and summary carries the run's nonce. Markers are
 * `BUGSEE_E2E cov <what> ...`.
 */
import { Platform } from 'react-native';
import type {
  Status} from '@bugsee/react-native';
import Bugsee, {
  type LifecycleEvent,
  LogLevel,
  SpanStatus
} from '@bugsee/react-native';

import { deadEndpointUrl } from '../endpoint';

export const COVERAGE_SCENARIOS = [
  'cov-identity',
  'cov-lifecycle',
  'cov-apm',
  'cov-jscrash',
  'cov-dialog-color',
] as const;

/**
 * The launch-option cases. Each value is the option set the case adds to
 * the app's own (endpoint and duration=90, App.tsx). Values are the
 * numbers that cross the bridge; for an enum key that is the enum's
 * internal value, which the Android bridge must convert through its
 * enum table (BugseeOptionEnums.java), never by ordinal.
 *
 * The test (e2e/launch-options.test.ts) holds its own copy of each set and
 * of what each must change in the report. Platform-only keys are only ever
 * launched on their platform.
 */
export const OPTION_CASES = {
  /** Everything at the SDK's defaults: the control every "off" case is read against. */
  control: {},
  'video-off': { 'com.bugsee.option.capture.video': false },
  'screenshot-off': { 'com.bugsee.option.capture.screenshot': false },
  'logs-off': { 'com.bugsee.option.capture.logs': false },
  'network-off': { 'com.bugsee.option.capture.network': false },
  'vh-off': { 'com.bugsee.option.capture.view-hierarchy': false },
  'perf-off': { 'com.bugsee.option.performance.enabled': false },
  'crumbs-on': { 'com.bugsee.option.capture.breadcrumbs': true },
  /** LogLevel.Error (internal 1, ordinal 0 on Android). */
  'log-level-error': { 'com.bugsee.option.capture.logs.level': LogLevel.Error },
  /** FrameRate.Low (1; ordinal 0) and High (3; ordinal 2). */
  'frame-rate-low': { 'com.bugsee.option.capture.video.frame-rate': 1 },
  'frame-rate-high': { 'com.bugsee.option.capture.video.frame-rate': 3 },
  /** VideoQuality.High (2; the one enum whose value is its ordinal). */
  'quality-high': { 'com.bugsee.option.capture.video.quality': 2 },
  /**
   * IssueSeverity.Critical (4) as the default bug priority. An ordinal
   * lookup would pick values()[4], Blocker (5): a valid, different severity.
   */
  'bug-priority': { 'com.bugsee.option.reporting.defaults.bug-priority': 4 },
  /** IssueSeverity.VeryLow (1; ordinal 0) as the default error priority. */
  'error-priority': { 'com.bugsee.option.reporting.defaults.error-priority': 1 },
  'screenshot-scale': { 'com.bugsee.option.capture.screenshot.scale': 0.25 },
  'video-scale': { 'com.bugsee.option.capture.video.scale': 0.25 },
  /** Android VideoMode.None (0) -- an enum key, Android only. */
  'video-mode-none': { 'com.bugsee.option.capture.video.mode': 0 },
  /**
   * Android VideoMode.DirectBuffers (21; ordinal 4). An ordinal lookup has no
   * constant at 21, so the option would be dropped and V2 stay in effect.
   */
  'video-mode-direct': { 'com.bugsee.option.capture.video.mode': 21 },
  'max-pending-reports': { 'com.bugsee.option.config.max-pending-reports': 1 },
  /** setCustomOption with a key no accessor surfaces. */
  'custom-option': { 'com.bugsee.option.capture.network.body-size-limit': 7 },
} as const satisfies Record<string, Record<string, unknown>>;

export type OptionCase = keyof typeof OPTION_CASES;

const OPTION_PREFIX = 'opt-';

export type CoverageScenario = (typeof COVERAGE_SCENARIOS)[number];

export function isCoverageScenario(name: string): boolean {
  return (
    (COVERAGE_SCENARIOS as readonly string[]).includes(name) ||
    optionCaseOf(name) !== undefined
  );
}

export function optionCaseOf(scenario: string): OptionCase | undefined {
  if (!scenario.startsWith(OPTION_PREFIX)) {
    return undefined;
  }
  const name = scenario.slice(OPTION_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(OPTION_CASES, name)
    ? (name as OptionCase)
    : undefined;
}

/** 64 bytes of request body the network capture keeps, or cuts. */
export const POST_BODY = 'cov-body-'.padEnd(64, 'x');

function mark(message: string): void {
  console.log(`BUGSEE_E2E cov ${message}`);
}

/**
 * The option set the scenario launches with, written onto `options` (the
 * app's serialized launch payload). `opt-custom-option` goes through
 * `setCustomOption` on the typed model rather than the plain map, so the
 * accessor path is what reaches the bridge.
 */
export function launchOverrides(
  scenario: string,
  apply: (key: string, value: unknown) => void,
): void {
  const optionCase = optionCaseOf(scenario);
  const set: Record<string, unknown> | undefined =
    optionCase !== undefined ? OPTION_CASES[optionCase] : SCENARIO_OPTIONS[scenario];
  for (const [key, value] of Object.entries(set ?? {})) {
    apply(key, value);
  }
}

/**
 * Options the cov-* scenarios launch with. cov-jscrash sets the default
 * crash priority to IssueSeverity.Medium (2): an ordinal lookup would pick
 * values()[2], High (3), and the SDK's own default is neither.
 */
export const SCENARIO_OPTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  'cov-jscrash': { 'com.bugsee.option.reporting.defaults.crash-priority': 2 },
};

/** Every lifecycle event and status the scenario saw, in order. */
const seenEvents: string[] = [];
const seenStatuses: number[] = [];
let assembled: ((id: string) => void) | undefined;

/** Before launch(): the lifecycle subscriptions cov-lifecycle asserts. */
export function preLaunchCoverage(scenario: string, nonce: string): void {
  if (scenario !== 'cov-lifecycle') {
    return;
  }
  Bugsee.onLifecycleEvent((event: LifecycleEvent) => {
    const id = event.reportId ?? '';
    seenEvents.push(id === '' ? event.name : `${event.name}:${id}`);
    mark(`lifecycle nonce=${nonce} event=${event.name} report=${id === '' ? '-' : id}`);
    if (event.name === 'AfterReportAssembled' && id !== '') {
      assembled?.(id);
    }
  });
  Bugsee.onStatusChange((status: Status) => {
    seenStatuses.push(status);
    mark(`status-change nonce=${nonce} status=${status}`);
  });
  mark(`subscribed nonce=${nonce}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLifecycle(nonce: string): Promise<void> {
  const reportId = new Promise<string>(resolve => {
    assembled = resolve;
  });
  Bugsee.upload(`cov-lifecycle-${nonce}`, '');
  const id = await Promise.race([reportId, delay(30_000).then(() => 'timeout')]);
  mark(`assembled nonce=${nonce} id=${id}`);
  // The test lists the retained bundles in this window: the one just
  // assembled must be on disk before the deletion below.
  await delay(15_000);
  const stopped = await Bugsee.stop();
  const statusAfterStop = await Bugsee.getStatus();
  mark(`stopped nonce=${nonce} resolved=${String(stopped)} status=${statusAfterStop}`);
  // Ignored: the SDK is stopped. A bundle with this summary is the failure.
  Bugsee.upload(`cov-after-stop-${nonce}`, '');
  Bugsee.log(`cov after-stop line ${nonce}`);
  await delay(5_000);
  const deleted = await Bugsee.deleteCollectedDataOnDevice(true);
  mark(`deleted nonce=${nonce} result=${String(deleted)}`);
  await delay(1_000);
  mark(
    `summary nonce=${nonce} events=${JSON.stringify(seenEvents)} statuses=${JSON.stringify(seenStatuses)}`,
  );
}

function runApm(nonce: string): void {
  const transaction = Bugsee.startTransaction(`txn-start-${nonce}`, 'cov.flow');
  const active = Bugsee.getActiveSpan();
  mark(`apm active nonce=${nonce} same=${String(active === transaction)}`);
  transaction.setName(`txn-renamed-${nonce}`);
  transaction.setDescription(`txn-desc-${nonce}`);
  const child = Bugsee.startSpan('cov.child', `child-start-${nonce}`);
  const activeChild = Bugsee.getActiveSpan();
  mark(`apm active-child nonce=${nonce} same=${String(activeChild === child)}`);
  child.setDescription(`child-desc-${nonce}`);
  child.setStatus(SpanStatus.Cancelled);
  child.finish();
  const second = transaction.startChildSpan('cov.second', `second-${nonce}`);
  second.finish(SpanStatus.DeadlineExceeded);
  transaction.setStatus(SpanStatus.Error);
  transaction.finish();
  const afterFinish = Bugsee.getActiveSpan();
  mark(`apm finished nonce=${nonce} active-after=${afterFinish === null ? 'null' : 'span'}`);
  Bugsee.upload(`cov-apm-${nonce}`, '');
}

function runJsCrash(nonce: string): void {
  mark(`jscrash throwing nonce=${nonce}`);
  // Outside any try and off this turn, so only the global handler sees it.
  setTimeout(() => {
    Bugsee.testJsCrash();
  }, 0);
}

/** Pure red, opaque: nothing else on the dialog or the app is this color. */
export const DIALOG_COLOR = '#ff0000ff';

function runDialogColor(nonce: string): void {
  Bugsee.appearance.backgroundColor = DIALOG_COLOR;
  const read = Bugsee.appearance.backgroundColor ?? 'unread';
  Bugsee.showReportDialog(`cov-dialog-${nonce}`, '');
  mark(`dialog shown nonce=${nonce} background=${read}`);
}

/**
 * What every `opt-<case>` run does, whatever the options: one line through
 * each log route, a breadcrumb, a transaction, a fetch the network capture
 * can see (no "bugsee" in its URL: the iOS SDK drops those), a few
 * seconds of screen for the video, then the effective options and an
 * upload with no severity (so the default bug priority applies).
 */
async function runOptionCase(optionCase: OptionCase, nonce: string): Promise<void> {
  console.log(`cov-console info ${nonce}`);
  console.warn(`cov-console warn ${nonce}`);
  console.error(`cov-console error ${nonce}`);
  for (let level = 1; level <= 5; level += 1) {
    Bugsee.log(`cov-log L${level} ${nonce}`, level as LogLevel);
  }
  Bugsee.addBreadcrumb({
    category: 'cov',
    level: 'info',
    message: `cov-crumb ${nonce}`,
    type: 'user',
  });
  const transaction = Bugsee.startTransaction(`cov-txn-${nonce}`, 'cov.flow');
  transaction.finish();
  try {
    await fetch(deadEndpointUrl(`cov-fetch/${nonce}`));
  } catch {
    // The URL is closed; the request is what the capture records.
  }
  // A request body longer than the custom-option case's 7-byte limit.
  try {
    await fetch(deadEndpointUrl(`cov-post/${nonce}`), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: POST_BODY,
    });
  } catch {
    // As above.
  }
  if (optionCase === 'error-priority') {
    Bugsee.logException(new Error(`cov-error ${nonce}`));
  }
  await delay(4_000);
  const keys = Object.keys(OPTION_CASES[optionCase]);
  const effective = await Bugsee.getLaunchOptions();
  const picked = Object.fromEntries(keys.map(key => [key, effective[key] ?? null]));
  mark(
    `opt effective case=${optionCase} nonce=${nonce} platform=${Platform.OS} ` +
      `keys=${Object.keys(effective).length} values=${JSON.stringify(picked)}`,
  );
  const uploads = optionCase === 'max-pending-reports' ? 3 : 1;
  for (let i = 1; i <= uploads; i += 1) {
    const summary = uploads === 1 ? `opt-${optionCase}-${nonce}` : `opt-${optionCase}-${nonce}-${i}`;
    Bugsee.upload(summary, '');
    if (i < uploads) {
      await delay(3_000);
    }
  }
  mark(`opt uploaded case=${optionCase} nonce=${nonce} count=${uploads}`);
}

/** What the scenario does once the SDK is Launched. */
export async function runCoverageScenario(scenario: string, nonce: string): Promise<void> {
  const optionCase = optionCaseOf(scenario);
  if (optionCase !== undefined) {
    await runOptionCase(optionCase, nonce);
    return;
  }
  switch (scenario) {
    case 'cov-identity':
      Bugsee.upload(`cov-identity-${nonce}`, '');
      mark(`identity uploaded nonce=${nonce}`);
      return;
    case 'cov-lifecycle':
      await runLifecycle(nonce);
      return;
    case 'cov-apm':
      runApm(nonce);
      return;
    case 'cov-jscrash':
      runJsCrash(nonce);
      return;
    case 'cov-dialog-color':
      runDialogColor(nonce);
      return;
  }
}
