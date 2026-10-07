/**
 * The smoke set S1-S8 (beta campaign N-01): one scenario per
 * version-sensitive surface of the wrapper, so an app generated on another
 * React Native version, an Expo app or a packed-tarball install proves the
 * same things examples/bare does, with the same e2e (e2e/smoke.test.ts).
 *
 * Self-contained on purpose: this file needs only `react`, `react-native`
 * and `@bugsee/react-native` -- no `bugsee-e2e-native`, no other scenario
 * module -- so a generated app takes it by copying `smoke/` (and
 * `endpoint.ts`, which SmokeApp imports). examples/bare runs it from App.tsx;
 * a generated app runs it from SmokeApp.tsx.
 *
 *   smoke-identity   S1  one upload; the test reads environment.sdk.wrapper
 *   smoke-data       S2  Bugsee.log, console.log, event, trace, then an upload
 *   smoke-exception  S3  logException with a synthetic debug-id registration
 *   smoke-upload     S4  upload(summary, description, severity, labels) and
 *                        the AfterReportAssembled id
 *   smoke-view-tree  S5  captureViewHierarchy over a probe, then an upload
 *   smoke-secure     S6  <BugseeSecure> around a magenta box, an open cyan
 *                        box beside it, then an upload
 *   smoke-fatal      S7  a JS error thrown on its own turn (the global
 *                        ErrorUtils handler), recovered at the next launch
 *   smoke-relaunch   S7  the next launch: nothing but launch
 *   smoke-map-id     S8  logException with the build's own debug ids (Release)
 *
 * Markers are `BUGSEE_E2E smoke <what> nonce=<n>`; every summary, message
 * and name carries the run's nonce.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Bugsee, { BugseeSecure, IssueSeverity } from '@bugsee/react-native';

import { SMOKE_OPEN_COLOUR, SMOKE_SECURE_COLOUR, smokeDebugIdFor } from './constants';

export const SMOKE_SCENARIOS = [
  'smoke-identity',
  'smoke-data',
  'smoke-exception',
  'smoke-upload',
  'smoke-view-tree',
  'smoke-secure',
  'smoke-fatal',
  'smoke-relaunch',
  'smoke-map-id',
] as const;

export type SmokeScenario = (typeof SMOKE_SCENARIOS)[number];

export function isSmokeScenario(name: string): name is SmokeScenario {
  return (SMOKE_SCENARIOS as readonly string[]).includes(name);
}

/** The two scenarios that render a stage once Launched. */
export type SmokeStageScenario = 'smoke-view-tree' | 'smoke-secure';

export function isSmokeStageScenario(name: string): name is SmokeStageScenario {
  return name === 'smoke-view-tree' || name === 'smoke-secure';
}

export { SMOKE_OPEN_COLOUR, SMOKE_SECURE_COLOUR, smokeDebugIdFor } from './constants';

function mark(message: string): void {
  console.log(`BUGSEE_E2E smoke ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Registers a synthetic debug-id map keyed by a stack whose top frame is in
 * this bundle -- the bundle the throw site below lives in -- as the
 * `sourcemaps inject` stub would for a real build.
 */
function registerSmokeDebugIds(nonce: string): void {
  (globalThis as { _bugseeDebugIds?: Record<string, string> })._bugseeDebugIds = {
    [new Error().stack!]: smokeDebugIdFor(nonce),
  };
}

export function bugseeSmokeThrowSite(nonce: string): never {
  throw new TypeError(`smoke handled ${nonce}`);
}

/**
 * Called once the SDK is Launched. The stage scenarios do their work in
 * `SmokeStage`, which the host app mounts for them (`isSmokeStageScenario`).
 */
export async function runSmokeScenario(scenario: SmokeScenario, nonce: string): Promise<void> {
  switch (scenario) {
    case 'smoke-identity':
      Bugsee.upload(`smoke-identity-${nonce}`, '');
      mark(`identity uploaded nonce=${nonce}`);
      return;
    case 'smoke-data':
      Bugsee.log(`smoke log ${nonce}`);
      console.log(`smoke console ${nonce}`);
      Bugsee.event(`smoke-event-${nonce}`, { n: 1, s: `v-${nonce}`, b: true });
      Bugsee.trace(`smoke-trace-${nonce}`, 7);
      mark(`data sent nonce=${nonce}`);
      Bugsee.upload(`smoke-data-${nonce}`, '');
      return;
    case 'smoke-exception':
      registerSmokeDebugIds(nonce);
      try {
        bugseeSmokeThrowSite(nonce);
      } catch (error) {
        Bugsee.logException(error);
      }
      mark(`exception sent nonce=${nonce}`);
      return;
    case 'smoke-upload': {
      Bugsee.onLifecycleEvent(event => {
        if (event.name === 'AfterReportAssembled' && event.reportId) {
          mark(`assembled id=${event.reportId} nonce=${nonce}`);
        }
      });
      Bugsee.upload(`smoke-up-${nonce}`, `smoke-desc-${nonce}`, IssueSeverity.High, ['smoke', `l-${nonce}`]);
      mark(`upload sent nonce=${nonce}`);
      return;
    }
    case 'smoke-fatal':
      mark(`fatal throwing nonce=${nonce}`);
      // Its own turn, outside any try: only the global handler sees it.
      setTimeout(() => {
        throw new Error(`smoke fatal ${nonce}`);
      }, 0);
      return;
    case 'smoke-relaunch':
      mark(`relaunched nonce=${nonce}`);
      return;
    case 'smoke-map-id':
      // No registration: the build's own `_bugseeDebugIds`, as injected.
      try {
        throw new Error(`smoke map-id ${nonce}`);
      } catch (error) {
        Bugsee.logException(error);
      }
      mark(`map-id sent nonce=${nonce}`);
      return;
    case 'smoke-view-tree':
    case 'smoke-secure':
      return;
  }
}

/** Mounted by the host app once Launched, for the two stage scenarios. */
export function SmokeStage({ scenario, nonce }: { scenario: SmokeStageScenario; nonce: string }) {
  return (
    <View style={styles.stage} testID="smoke-stage">
      {scenario === 'smoke-view-tree' ? <SmokeViewTreeProbe nonce={nonce} /> : <SmokeSecureProbe nonce={nonce} />}
    </View>
  );
}

function SmokeViewTreeProbe({ nonce }: { nonce: string }) {
  useEffect(() => {
    (async () => {
      await sleep(1000);
      Bugsee.captureViewHierarchy();
      mark(`vh captured t=${Date.now()} nonce=${nonce}`);
      await sleep(1000);
      Bugsee.upload(`smoke-vh-${nonce}`, '');
      mark(`vh uploaded t=${Date.now()} nonce=${nonce}`);
    })().catch((error: unknown) => mark(`vh threw ${String(error)} nonce=${nonce}`));
  }, [nonce]);
  return (
    <>
      <View testID={`smoke-vh-open-${nonce}`} nativeID={`smoke-vh-native-${nonce}`} style={styles.box}>
        <Text>smoke open</Text>
      </View>
      <BugseeSecure>
        <View testID={`smoke-vh-secure-${nonce}`} style={styles.box}>
          <Text>smoke secure</Text>
        </View>
      </BugseeSecure>
    </>
  );
}

function SmokeSecureProbe({ nonce }: { nonce: string }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    (async () => {
      // Long enough for the secure rect to reach the SDK and a frame to settle.
      await sleep(1500);
      Bugsee.upload(`smoke-secure-${nonce}`, '');
      mark(`secure uploaded nonce=${nonce}`);
    })().catch((error: unknown) => mark(`secure threw ${String(error)} nonce=${nonce}`));
  }, [nonce]);
  return (
    <>
      <BugseeSecure>
        <View style={[styles.square, { backgroundColor: SMOKE_SECURE_COLOUR }]} />
      </BugseeSecure>
      <View style={[styles.square, { backgroundColor: SMOKE_OPEN_COLOUR }]} />
    </>
  );
}

const styles = StyleSheet.create({
  stage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: { width: 200, height: 80, margin: 12, backgroundColor: '#EEEEEE', justifyContent: 'center', alignItems: 'center' },
  square: { width: 160, height: 160, margin: 16 },
});
