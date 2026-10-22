/**
 * Launch, attach, relaunch and lifecycle-event scenarios (N-02, N-03, N-09).
 *
 *   api-attach          before any launch(): getStatus, attach(), getStatus,
 *                       getLaunchOptions. On an Android build made with
 *                       `-PbugseeE2eAutoLaunch=true` the SDK launched itself
 *                       from the manifest (`com.bugsee.app-token`), so the
 *                       scenario never calls launch(): it logs a console line,
 *                       reports a handled error and uploads. Anywhere else
 *                       nothing launched, attach() must start nothing, and the
 *                       app then launches as usual (N-02).
 *   api-relaunch        upload, relaunch() with screenshots off and duration
 *                       45, read the options back, upload again (N-03).
 *   api-launch-after-stop  stop(), launch() again, upload (N-03, FLOW-41).
 *   api-second-launch   launch() again while Launched with duration 30: the
 *                       status, events and options must not move (N-03).
 *   api-blackout-stop   startBlackout(), stop(), launch() again, read the
 *                       blackout back (#143; e2e/blackout-stop.test.ts).
 *   api-blackout-stop-idle  stop() and launch() with no blackout in force: no
 *                       BlackoutEnded (#143).
 *   api-blackout-prelaunch-stop  startBlackout() and stop() both before the
 *                       first launch(): the blackout is held until launch
 *                       (#143).
 *   api-crash           a native SIGSEGV once Launched (N-09).
 *   api-after-crash     subscribes before launch(), logs what it saw (N-09).
 *   api-dialog-events   subscribes before launch(), opens the report dialog
 *                       (N-09).
 *   api-upload-events   subscribes before launch(), uploads, waits for the
 *                       upload to fail against the dead endpoint (N-09).
 */
import Bugsee, { Status } from '@bugsee/react-native';
import { crashNative } from 'bugsee-e2e-native';

import { type ApiContext, delay, mark, recordEvents, settle } from './api-common';

export const LIFECYCLE_SCENARIOS = [
  'api-attach',
  'api-relaunch',
  'api-launch-after-stop',
  'api-second-launch',
  'api-blackout-stop',
  'api-blackout-stop-idle',
  'api-blackout-prelaunch-stop',
  'api-crash',
  'api-after-crash',
  'api-dialog-events',
  'api-upload-events',
] as const;

const DETECT_CRASH = 'com.bugsee.option.detect.crash';
const DURATION = 'com.bugsee.option.config.duration';
const SCREENSHOT = 'com.bugsee.option.capture.screenshot';

/** Events recorded by the scenarios that subscribe before launch(). */
let events: string[] = [];

/**
 * Before launch(). Returns true when the scenario owns the launch and the
 * app must not call launch() itself (api-attach on a manifest build).
 */
export async function preLaunchLifecycle(scenario: string, nonce: string): Promise<boolean> {
  switch (scenario) {
    case 'api-attach':
      return attach(nonce);
    case 'api-after-crash':
    case 'api-dialog-events':
    case 'api-upload-events':
    case 'api-second-launch':
    case 'api-launch-after-stop':
    case 'api-blackout-stop':
    case 'api-blackout-stop-idle':
      events = recordEvents(nonce, scenario.slice(4));
      return false;
    case 'api-blackout-prelaunch-stop':
      events = recordEvents(nonce, scenario.slice(4));
      Bugsee.startBlackout();
      mark(`bps called nonce=${nonce}`);
      // The SDK was never launched: this stop() must not cancel the blackout.
      mark(`bps stopped nonce=${nonce} result=${await settle(() => Bugsee.stop())}`);
      return false;
    default:
      return false;
  }
}

async function attach(nonce: string): Promise<boolean> {
  const before = await Bugsee.getStatus();
  mark(`attach before nonce=${nonce} status=${before}`);
  const attached = await settle(() => Bugsee.attach());
  const after = await Bugsee.getStatus();
  const options = await Bugsee.getLaunchOptions().catch(() => ({}) as Record<string, unknown>);
  mark(
    `attach done nonce=${nonce} status=${after} result=${attached} ` +
      `detectCrash=${String(options[DETECT_CRASH])} keys=${Object.keys(options).length}`,
  );
  if (after !== Status.Launched) {
    // Nothing launched: attach() must not have started anything.
    await delay(3_000);
    mark(`attach idle nonce=${nonce} status=${await Bugsee.getStatus()}`);
    return false;
  }
  // The SDK launched itself from the manifest. attach() installed the
  // console patch and the exception handlers; this run never calls launch().
  console.log(`api-attach console ${nonce}`);
  Bugsee.logException(new Error(`api-attach handled ${nonce}`));
  await delay(2_000);
  Bugsee.upload(`api-attach-${nonce}`, '');
  mark(`attach uploaded nonce=${nonce}`);
  return true;
}

/** Once Launched. */
export async function runLifecycleScenario(scenario: string, nonce: string, context: ApiContext): Promise<void> {
  switch (scenario) {
    case 'api-attach':
      // Reached only when nothing auto-launched and the app launched itself.
      mark(`attach launched nonce=${nonce} status=${await Bugsee.getStatus()}`);
      return;
    case 'api-relaunch':
      return relaunch(nonce, context);
    case 'api-launch-after-stop':
      return launchAfterStop(nonce, context);
    case 'api-second-launch':
      return secondLaunch(nonce, context);
    case 'api-blackout-stop':
      return blackoutStop(nonce, context, true);
    case 'api-blackout-stop-idle':
      return blackoutStop(nonce, context, false);
    case 'api-blackout-prelaunch-stop':
      return blackoutPrelaunchStop(nonce);
    case 'api-crash':
      // A native signal, not testNativeCrash(): a Debug build's red box
      // catches the Java exception before it can kill the process.
      mark(`crash crashing nonce=${nonce}`);
      setTimeout(() => crashNative('segv'), 500);
      return;
    case 'api-after-crash':
      await delay(12_000);
      mark(`after-crash summary nonce=${nonce} events=${JSON.stringify(events)}`);
      return;
    case 'api-dialog-events':
      // Each event is its own marker (recordEvents): JS timers stop while
      // the dialog's activity is on top, so no summary is waited for here.
      Bugsee.showReportDialog(`api-dialog-${nonce}`, '');
      mark(`dialog-events shown nonce=${nonce}`);
      return;
    case 'api-upload-events':
      Bugsee.upload(`api-upload-${nonce}`, '');
      mark(`upload-events uploaded nonce=${nonce}`);
      await delay(40_000);
      mark(`upload-events summary nonce=${nonce} events=${JSON.stringify(events)}`);
      return;
  }
}

async function relaunch(nonce: string, context: ApiContext): Promise<void> {
  const before = await Bugsee.getLaunchOptions();
  mark(`relaunch first nonce=${nonce} duration=${String(before[DURATION])} screenshot=${String(before[SCREENSHOT])}`);
  Bugsee.upload(`api-rl-before-${nonce}`, '');
  await delay(6_000);
  const changed = { ...context.options(), [DURATION]: 45, [SCREENSHOT]: false };
  const settled = await settle(() => Bugsee.relaunch(changed));
  const status = await Bugsee.getStatus();
  const after = await Bugsee.getLaunchOptions();
  mark(
    `relaunch settled nonce=${nonce} result=${settled} status=${status} ` +
      `duration=${String(after[DURATION])} screenshot=${String(after[SCREENSHOT])}`,
  );
  await delay(4_000);
  Bugsee.upload(`api-rl-after-${nonce}`, '');
  mark(`relaunch uploaded nonce=${nonce}`);
}

async function launchAfterStop(nonce: string, context: ApiContext): Promise<void> {
  const stopped = await settle(() => Bugsee.stop());
  const statusStopped = await Bugsee.getStatus();
  mark(`las stopped nonce=${nonce} result=${stopped} status=${statusStopped}`);
  await delay(2_000);
  const launched = await settle(() => Bugsee.launch(context.token, context.options()));
  const deadline = Date.now() + 15_000;
  let status = await Bugsee.getStatus();
  while (status !== Status.Launched && Date.now() < deadline) {
    await delay(200);
    status = await Bugsee.getStatus();
  }
  mark(`las relaunched nonce=${nonce} result=${launched} status=${status}`);
  await delay(4_000);
  console.log(`api-las console ${nonce}`);
  Bugsee.upload(`api-las-${nonce}`, '');
  await delay(3_000);
  mark(`las summary nonce=${nonce} events=${JSON.stringify(events)}`);
}

async function secondLaunch(nonce: string, context: ApiContext): Promise<void> {
  const from = events.length;
  const second = await settle(() => Bugsee.launch(context.token, { ...context.options(), [DURATION]: 30 }));
  await delay(5_000);
  const status = await Bugsee.getStatus();
  const options = await Bugsee.getLaunchOptions();
  mark(
    `second result nonce=${nonce} result=${second} status=${status} duration=${String(options[DURATION])} ` +
      `events=${JSON.stringify(events.slice(from))}`,
  );
  Bugsee.upload(`api-second-${nonce}`, '');
  mark(`second uploaded nonce=${nonce}`);
}

/** launch() with the app's options, waited for Launched (up to 15 s). */
async function launchAndWait(context: ApiContext): Promise<{ result: string; status: Status }> {
  const result = await settle(() => Bugsee.launch(context.token, context.options()));
  const deadline = Date.now() + 15_000;
  let status = await Bugsee.getStatus();
  while (status !== Status.Launched && Date.now() < deadline) {
    await delay(200);
    status = await Bugsee.getStatus();
  }
  return { result, status };
}

/**
 * #143. Launched -> [startBlackout()] -> stop() -> launch() -> read back.
 * `bs <step>` markers bracket the calls so the test can place each lifecycle
 * event (`blackout-stop event ...`, recordEvents) before or after them.
 */
async function blackoutStop(nonce: string, context: ApiContext, withBlackout: boolean): Promise<void> {
  if (withBlackout) {
    Bugsee.startBlackout();
  }
  mark(`bs started nonce=${nonce} withBlackout=${String(withBlackout)} isBlackout=${String(await Bugsee.isBlackout())}`);
  const stopped = await settle(() => Bugsee.stop());
  mark(`bs stopped nonce=${nonce} result=${stopped} status=${await Bugsee.getStatus()}`);
  // Events are delivered asynchronously: wait (bounded) for BlackoutEnded to
  // land before the next marker, so its position says which call caused it.
  // The idle case expects no event and just observes for the same interval.
  const settleBy = Date.now() + (withBlackout ? 10_000 : 2_000);
  while (Date.now() < settleBy && !(withBlackout && events.some(name => name.startsWith('BlackoutEnded')))) {
    await delay(100);
  }
  mark(`bs after-stop nonce=${nonce}`);
  const { result, status } = await launchAndWait(context);
  mark(`bs relaunched nonce=${nonce} result=${result} status=${status} isBlackout=${String(await Bugsee.isBlackout())}`);
  await delay(2_000);
  mark(`bs summary nonce=${nonce}`);
}

/** #143. startBlackout() and stop() ran before launch() (preLaunchLifecycle). */
async function blackoutPrelaunchStop(nonce: string): Promise<void> {
  mark(`bps launched nonce=${nonce} isBlackout=${String(await Bugsee.isBlackout())}`);
  Bugsee.endBlackout();
  await delay(2_000);
  mark(`bps cleared nonce=${nonce} isBlackout=${String(await Bugsee.isBlackout())}`);
}
