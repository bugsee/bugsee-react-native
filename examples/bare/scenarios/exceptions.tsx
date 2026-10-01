/**
 * The JS-exception scenarios Task 7.5a drives on a device
 * (e2e/exceptions.test.ts).
 *
 * Every value carries the run's nonce. Before the first throw, the scenario
 * registers `globalThis._bugseeDebugIds` from inside a function in this file
 * (its top frame shares the bundle with every throw site), simulating Phase
 * 13's inject stub. The app-level ErrorUtils handler is installed before
 * `launch()` so Bugsee's handler chains to it (case 9).
 *
 * Markers (console.log → ReactNativeJS on Android):
 *   BUGSEE_E2E exc handled-sent nonce=<n>
 *   BUGSEE_E2E exc rejection-sent nonce=<n>
 *   BUGSEE_E2E exc prelaunch-sent nonce=<n>
 *   BUGSEE_E2E exc boundary-onError
 *   BUGSEE_E2E exc boundary-fallback
 *   BUGSEE_E2E exc app-handler fatal=<bool>
 */
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Bugsee, { ErrorBoundary } from '@bugsee/react-native';

export const EXCEPTION_SCENARIOS = [
  'exc-handled',
  'exc-rejection',
  'exc-fatal',
  'exc-boundary',
  'exc-root',
  'exc-prelaunch',
  'exc-observe',
] as const;

export type ExceptionScenario = (typeof EXCEPTION_SCENARIOS)[number];

export function isExceptionScenario(name: string): name is ExceptionScenario {
  return (EXCEPTION_SCENARIOS as readonly string[]).includes(name);
}

/** Scenarios that mount a React tree after Launched. */
export function isExceptionRenderScenario(
  name: string,
): name is 'exc-boundary' | 'exc-root' {
  return name === 'exc-boundary' || name === 'exc-root';
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E exc ${message}`);
}

function debugIdFor(nonce: string): string {
  return `8a1c2f4e-0d3b-5e6f-9a7b-${nonce.padStart(12, '0').slice(-12)}`;
}

/**
 * Registers a synthetic debug-ID map whose key is a stack whose top frame is
 * in this bundle — the same bundle every throw site lives in.
 */
export function registerDebugIds(nonce: string): void {
  const ID = debugIdFor(nonce);
  (globalThis as { _bugseeDebugIds?: Record<string, string> })._bugseeDebugIds = {
    [new Error().stack!]: ID,
  };
}

export function bugseeE2EThrowSite(n: string): never {
  const e = new TypeError(`E2E handled ${n}`);
  (e as { cause?: unknown }).cause = new RangeError(`inner ${n}`);
  (e as { secretToken?: string }).secretToken = `tok-${n}`;
  throw e;
}

type ErrorUtilsLike = {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

/**
 * Installs the app-level ErrorUtils handler before `launch()`, so Bugsee's
 * installer chains to it. Proves the fatal path reaches RN after ours.
 */
export function installExceptionAppHandler(): void {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (utils === undefined) {
    mark('no-ErrorUtils');
    return;
  }
  const rnDefault = utils.getGlobalHandler();
  utils.setGlobalHandler((e, f) => {
    mark(`app-handler fatal=${String(f)}`);
    rnDefault(e, f);
  });
}

/** `exc-prelaunch`: a handled report before `launch()`, which must not file. */
export function preLaunchExceptionProbe(nonce: string): void {
  registerDebugIds(nonce);
  Bugsee.logException(new Error(`pre-${nonce}`));
  mark(`prelaunch-sent nonce=${nonce}`);
}

export function BugseeE2EThrower({ n }: { n: string }): never {
  throw new Error(`E2E boundary ${n}`);
}

function BoundaryFallback({ n }: { n: string }) {
  useEffect(() => {
    mark('boundary-fallback');
  }, [n]);
  return (
    <View>
      <Text>boundary-fallback {n}</Text>
    </View>
  );
}

/** Mounted after Launched for `exc-boundary` / `exc-root`. */
export function ExceptionStage({
  scenario,
  nonce,
}: {
  scenario: 'exc-boundary' | 'exc-root';
  nonce: string;
}) {
  // Before BugseeE2EThrower's first render throw — useEffect would never run.
  registerDebugIds(nonce);

  if (scenario === 'exc-boundary') {
    return (
      <ErrorBoundary
        fallback={<BoundaryFallback n={nonce} />}
        onError={() => mark('boundary-onError')}
      >
        <BugseeE2EThrower n={nonce} />
      </ErrorBoundary>
    );
  }
  return <BugseeE2EThrower n={nonce} />;
}

/** What the scenario does once the SDK is Launched (non-render cases). */
export function runExceptionScenario(
  scenario: ExceptionScenario,
  nonce: string,
): void {
  if (scenario === 'exc-observe' || isExceptionRenderScenario(scenario)) {
    return;
  }
  if (scenario === 'exc-prelaunch') {
    return;
  }

  registerDebugIds(nonce);

  if (scenario === 'exc-handled') {
    try {
      bugseeE2EThrowSite(nonce);
    } catch (e) {
      Bugsee.logException(e, {
        domain: `e2e-${nonce}`,
        labels: ['e2e', `lbl-${nonce}`],
        includeVideo: true,
      });
    }
    Bugsee.logException({ password: `pw-${nonce}`, message: `obj-${nonce}` });
    mark(`handled-sent nonce=${nonce}`);
    return;
  }

  if (scenario === 'exc-rejection') {
    // Never handled: the rejection tracker reports it as a handled error.
    Promise.reject(new Error(`E2E rejection ${nonce}`));
    setTimeout(() => mark(`rejection-sent nonce=${nonce}`), 3_000);
    return;
  }

  if (scenario === 'exc-fatal') {
    setTimeout(() => {
      throw new Error(`E2E fatal ${nonce}`);
    }, 0);
    return;
  }
}
