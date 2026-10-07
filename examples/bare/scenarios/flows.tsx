/**
 * The campaign's flow scenarios (plan N-10, N-15, N-16): what the app does
 * across process and app-state boundaries. Driven by e2e/app-state.test.ts,
 * e2e/upgrade.test.ts and e2e/network-own-traffic.test.ts; the staging
 * scenarios (N-19) are scenarios/staging.ts, dispatched from here too so
 * App.tsx carries one additive block.
 *
 *   flow-cold           Launched, nothing else (cold start timing, FLOW-31;
 *                       first-launch prompt check, FLOW-40).
 *   flow-resume         counts background -> active transitions; after the
 *                       second resume the stage turns white, and 3 s later
 *                       uploads `flow-resume-<n>` (FLOW-32).
 *   flow-long           as flow-resume after one resume (FLOW-33).
 *   flow-reload         Debug only: generation 1 installs a log filter, a
 *                       report handler and a secure rectangle, uploads, then
 *                       `DevSettings.reload()`; generation 2 (same nonce, a
 *                       flag file in the cache directory tells it apart)
 *                       installs its own filter and handler, no rectangle,
 *                       and uploads (FLOW-34).
 *   flow-vh-deadline    `captureViewHierarchy()` and then the JS thread busy
 *                       for 2 s, so the vh request misses its 450 ms budget;
 *                       then an upload with JS free (FLOW-22).
 *   flow-main-responsive a live report handler that holds the report for
 *                       3 s while the main thread is pinged every 50 ms
 *                       (`blockMain(0)` round trips); a blockMain(1500)
 *                       control first proves the ping sees a blocked main
 *                       (DES-16).
 *   flow-upgrade-observe after an upgrade: reads the attributes and the user
 *                       id the previous build left, with a crash handler
 *                       registered before launch (FLOW-37..39).
 *   net-own-traffic     the two fetches of scenarios/network.ts, an upload,
 *                       its upload outcome (the SDK's own traffic to the
 *                       endpoint, attempted), then a second upload whose
 *                       capture must not hold that traffic (BLK-30).
 *
 * Markers: `BUGSEE_E2E flow <what> ... nonce=<n>`. No url here contains the
 * word "bugsee" except the one `bugseeNamedUrl` builds on purpose.
 */
import { useEffect, useState } from 'react';
import { AppState, DevSettings, Dimensions, StyleSheet, View } from 'react-native';
import Bugsee, { type BugseeReportHandler, type LifecycleEvent } from '@bugsee/react-native';
import { blockMain, fileExists, writeTempFile } from 'bugsee-e2e-native';

import { bugseeFetchUrl, fetchUrl } from './network';
import { STAGING_SCENARIOS, isStagingScenario, preLaunchStaging, runStagingScenario } from './staging';

export const FLOW_SCENARIOS = [
  'flow-cold',
  'flow-resume',
  'flow-long',
  'flow-reload',
  'flow-vh-deadline',
  'flow-main-responsive',
  'flow-upgrade-observe',
  'net-own-traffic',
  ...STAGING_SCENARIOS,
] as const;

export type FlowScenario = (typeof FLOW_SCENARIOS)[number];

export function isFlowScenario(name: string): name is FlowScenario {
  return (FLOW_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E flow ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The JS thread busy for `ms`, with nothing yielded: no event, no timer runs. */
function busyJs(ms: number): number {
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) {
    spins += 1;
  }
  return spins;
}

// ---------------------------------------------------------------------------
// The stage: a full-screen colour the video and screenshot assertions read.

type StageColour = 'none' | 'white';

let stageColour: StageColour = 'none';
const stageListeners = new Set<(colour: StageColour) => void>();

function setStage(colour: StageColour): void {
  stageColour = colour;
  for (const listener of stageListeners) {
    listener(colour);
  }
}

/** Mounted for every flow scenario; draws nothing until a scenario paints it. */
export function FlowStage() {
  const [colour, setColour] = useState<StageColour>(stageColour);
  useEffect(() => {
    stageListeners.add(setColour);
    return () => {
      stageListeners.delete(setColour);
    };
  }, []);
  if (colour === 'none') {
    return null;
  }
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.white]} />;
}

const styles = StyleSheet.create({
  white: { backgroundColor: '#ffffff', zIndex: 1000, elevation: 1000 },
});

// ---------------------------------------------------------------------------

function subscribeEvents(nonce: string): void {
  Bugsee.onLifecycleEvent((event: LifecycleEvent) => {
    mark(`event name=${event.name} id=${event.reportId ?? '-'} nonce=${nonce}`);
  });
}

/** Before `launch()`: subscriptions and handlers that must see the launch itself. */
export function preLaunchFlow(scenario: FlowScenario, nonce: string): void {
  if (isStagingScenario(scenario)) {
    preLaunchStaging(scenario, nonce);
    return;
  }
  if (
    scenario === 'flow-cold' ||
    scenario === 'flow-resume' ||
    scenario === 'flow-long' ||
    scenario === 'net-own-traffic'
  ) {
    subscribeEvents(nonce);
  }
  if (scenario === 'flow-upgrade-observe') {
    subscribeEvents(nonce);
    // A crash the previous build left is offered to a handler registered
    // before launch (as scenarios/native.ts `native-crash-recover`).
    Bugsee.setReportHandler({
      onBeforeReportCreated: report => {
        mark(`upgrade before type=${report.type} id=${report.id} nonce=${nonce}`);
      },
      onAfterReportCreated: report => {
        mark(`upgrade after type=${report.type} id=${report.id} nonce=${nonce}`);
      },
    });
  }
}

/**
 * flow-resume / flow-long: after `resumes` background -> active transitions,
 * the stage turns white (the video must show it: capture resumed) and a report
 * is filed. Every transition is marked with the SDK's status at that moment.
 */
function runResume(nonce: string, resumes: number, label: string): void {
  Bugsee.log(`pre-${label}-${nonce}`);
  let backgrounded = 0;
  let resumed = 0;
  mark(`resume ready resumes=${resumes} nonce=${nonce}`);
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'background') {
      backgrounded += 1;
      mark(`background k=${backgrounded} nonce=${nonce}`);
      return;
    }
    if (state !== 'active' || backgrounded <= resumed) {
      return;
    }
    resumed += 1;
    const k = resumed;
    Bugsee.getStatus().then(status => {
      mark(`resumed k=${k} status=${status} nonce=${nonce}`);
      Bugsee.log(`resume-${k}-${nonce}`);
      if (k < resumes) {
        return;
      }
      subscription.remove();
      setStage('white');
      sleep(3_000).then(() => {
        Bugsee.log(`post-resume-${nonce}`);
        Bugsee.upload(`${label}-${nonce}`, '');
        mark(`uploaded summary=${label}-${nonce} nonce=${nonce}`);
      });
    });
  });
}

/** The fraction of the window the reload scenario's first generation masks. */
export const RELOAD_SECURE_FRACTION = { x: 0.1, y: 0.3, w: 0.4, h: 0.25 } as const;

async function runReload(nonce: string): Promise<void> {
  const flag = `flow-reload-${nonce}.flag`;
  // writeTempFile resolves the path; fileExists needs it. Write nothing yet:
  // the probe of an absent file is the first generation's witness.
  const probePath = await writeTempFile(`flow-reload-${nonce}.probe`, 'probe');
  const flagPath = probePath.replace(/[^/\\]+$/, flag);
  const generation = (await fileExists(flagPath)) ? 2 : 1;
  const tag = `g${generation}`;
  mark(`reload generation=${generation} nonce=${nonce}`);
  setStage('white');

  // Rewrites only this run's probe lines: a line it rewrites carries the
  // generation that installed it, so a stale filter (generation 1 still
  // answering after the reload) or two filters at once show in the bundle.
  Bugsee.setLogFilter(line => (line.includes('rl-gen') && line.includes(nonce) ? `${tag}:${line}` : line));
  const handler: BugseeReportHandler = {
    async onBeforeReportCreated(report) {
      await report.setLabels([`${tag}-${nonce}`]);
      mark(`reload handler gen=${generation} type=${report.type} nonce=${nonce}`);
    },
  };
  Bugsee.setReportHandler(handler);

  if (generation === 1) {
    const { width, height } = Dimensions.get('window');
    Bugsee.setSecureRectangles([
      {
        x: Math.round(width * RELOAD_SECURE_FRACTION.x),
        y: Math.round(height * RELOAD_SECURE_FRACTION.y),
        width: Math.round(width * RELOAD_SECURE_FRACTION.w),
        height: Math.round(height * RELOAD_SECURE_FRACTION.h),
      },
    ]);
  }
  await sleep(1_500);
  console.log(`rl-gen${generation}-${nonce}`);
  await sleep(1_500);
  Bugsee.upload(`flow-reload-${tag}-${nonce}`, '');
  mark(`reload uploaded gen=${generation} nonce=${nonce}`);
  if (generation === 1) {
    // Long enough for the report to be assembled with this generation's
    // handler before the runtime it lives in goes away.
    await sleep(6_000);
    await writeTempFile(flag, tag);
    mark(`reload reloading nonce=${nonce}`);
    DevSettings.reload('flow-reload');
  }
}

async function runVhDeadline(nonce: string): Promise<void> {
  setStage('white');
  await sleep(1_000);
  mark(`vh blocking start nonce=${nonce}`);
  Bugsee.captureViewHierarchy();
  const spins = busyJs(2_000);
  mark(`vh blocking end spins=${spins} nonce=${nonce}`);
  await sleep(1_500);
  mark(`vh free capture nonce=${nonce}`);
  Bugsee.captureViewHierarchy();
  await sleep(1_500);
  Bugsee.upload(`flow-vh-${nonce}`, '');
  mark(`vh uploaded nonce=${nonce}`);
}

/**
 * The main-thread witness: pings the main thread (`blockMain(0)` posts a task
 * to it and resolves once it ran) every 50 ms until `stop()`, and keeps the
 * slowest round trip. A busy main thread shows as a slow ping on both
 * platforms; JS timers alone do not show it (iOS runs them off main).
 */
function mainPinger(): { stop: () => Promise<{ pings: number; maxPingMs: number }> } {
  let running = true;
  let pings = 0;
  let maxPingMs = 0;
  const loop = (async () => {
    while (running) {
      const started = Date.now();
      await blockMain(0);
      maxPingMs = Math.max(maxPingMs, Date.now() - started);
      pings += 1;
      await sleep(50);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { pings, maxPingMs };
    },
  };
}

const HANDLER_HOLD_MS = 3_000;

async function runMainResponsive(nonce: string): Promise<void> {
  setStage('white');
  // The control: a blocked main thread must show up as a slow ping.
  const control = mainPinger();
  await sleep(300);
  await blockMain(1_500);
  await sleep(300);
  const blocked = await control.stop();
  mark(`main control maxPing=${blocked.maxPingMs} pings=${blocked.pings} nonce=${nonce}`);

  Bugsee.setReportHandler({
    async onBeforeReportCreated(report) {
      mark(`main handler start type=${report.type} nonce=${nonce}`);
      const pinger = mainPinger();
      await sleep(HANDLER_HOLD_MS);
      const held = await pinger.stop();
      await report.setLabels([`held-${nonce}`]);
      mark(`main handler window ms=${HANDLER_HOLD_MS} maxPing=${held.maxPingMs} pings=${held.pings} nonce=${nonce}`);
    },
  });
  await sleep(500);
  Bugsee.upload(`flow-main-${nonce}`, '');
  mark(`main uploaded nonce=${nonce}`);
}

async function runUpgradeObserve(nonce: string): Promise<void> {
  const all = await Bugsee.getAllAttributes();
  const id = await Bugsee.getUserIdentifier();
  mark(`upgrade state all=${JSON.stringify(all)} id=${JSON.stringify(id ?? null)} nonce=${nonce}`);
  await sleep(10_000);
  mark(`upgrade done status=${await Bugsee.getStatus()} nonce=${nonce}`);
}

/** Resolves with the next upload outcome event for any report, or 'none'. */
function nextUploadOutcome(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      subscription.remove();
      resolve('none');
    }, timeoutMs);
    const subscription = Bugsee.onLifecycleEvent(event => {
      if (/^(AfterReportUploaded|ReportUploadFailed|ReportUploadFailedWithFutureRetry)$/.test(event.name)) {
        clearTimeout(timer);
        subscription.remove();
        resolve(event.name);
      }
    });
  });
}

async function fetchAndMark(url: string, label: string, nonce: string): Promise<void> {
  try {
    const response = await fetch(url);
    mark(`own ${label} status=${response.status} nonce=${nonce}`);
  } catch (error) {
    mark(`own ${label} failed ${error instanceof Error ? error.message : String(error)} nonce=${nonce}`);
  }
}

async function runOwnTraffic(nonce: string): Promise<void> {
  // Report 1: its upload is the SDK's own request to the configured endpoint.
  const outcome1 = nextUploadOutcome(60_000);
  Bugsee.upload(`own-1-${nonce}`, '');
  mark(`own first uploaded nonce=${nonce}`);
  mark(`own first outcome=${await outcome1} nonce=${nonce}`);
  // Then the app's own requests, so report 2's capture has something to hold.
  await fetchAndMark(fetchUrl(nonce), 'fetch', nonce);
  await fetchAndMark(bugseeFetchUrl(nonce), 'named', nonce);
  await sleep(1_000);
  const outcome2 = nextUploadOutcome(60_000);
  Bugsee.upload(`own-2-${nonce}`, '');
  mark(`own second uploaded nonce=${nonce}`);
  mark(`own second outcome=${await outcome2} nonce=${nonce}`);
}

/** What the scenario does once the SDK is Launched. */
export async function runFlowScenario(scenario: FlowScenario, nonce: string): Promise<void> {
  try {
    if (isStagingScenario(scenario)) {
      await runStagingScenario(scenario, nonce);
      return;
    }
    switch (scenario) {
      case 'flow-cold':
        mark(`cold launched nonce=${nonce}`);
        return;
      case 'flow-resume':
        runResume(nonce, 2, 'flow-resume');
        return;
      case 'flow-long':
        runResume(nonce, 1, 'flow-long');
        return;
      case 'flow-reload':
        await runReload(nonce);
        return;
      case 'flow-vh-deadline':
        await runVhDeadline(nonce);
        return;
      case 'flow-main-responsive':
        await runMainResponsive(nonce);
        return;
      case 'flow-upgrade-observe':
        await runUpgradeObserve(nonce);
        return;
      case 'net-own-traffic':
        await runOwnTraffic(nonce);
        return;
    }
  } catch (error) {
    mark(`threw ${String(error)} scenario=${scenario} nonce=${nonce}`);
  }
}
