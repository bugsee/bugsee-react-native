/**
 * Task 13.5, local half: a release build's runtime `debug_ids` value equals
 * the `debug_id` on the composed Hermes source map (the map after
 * `compose-source-maps.js`, which is what `hermes-sourcemaps.js` injects
 * into). A Debug Metro bundle does not go through hermesc or that compose
 * step, so this file runs only with `E2E_RELEASE=1` and a release binary
 * already installed. This file uploads nothing; the build hook uploads the
 * composed map only when a real app token is configured.
 *
 * Android: debuggable release APK (`:app:assembleRelease
 * -PbugseeE2eDebuggable=true`), airplane mode on, bundles cleared. The
 * composed map is
 * `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`
 * unless `BUGSEE_COMPOSED_MAP` names another file.
 *
 * The scenario is `exc-map-id`. It does not call `registerDebugIds`, which
 * would replace the inject stub. `duration` stays 90. `startRun` still
 * requires `Status.Launched`.
 *
 * iOS Simulator cannot retain the exception payload: the SDK compiles
 * `logException` out there. A Debug simulator run is not this proof. An iOS
 * device run is skipped unless `BUGSEE_COMPOSED_MAP` names the composed map;
 * this file does not default that path to the Android release map.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type PulledBundle, airplane, crashOf, removePulledBundles } from './bundles';
import { ANDROID_PACKAGE, iosTarget } from './device';
import {
  ON_ANDROID,
  ON_IOS,
  type Run,
  awaitBundles,
  clearBundles,
  TARGET_NAME,
  must,
  report,
  startRun,
  useLog,
} from './harness';
import { type DeviceLog, IosConsole, Logcat, adb, resetScenario } from './scenario';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELEASE = process.env.E2E_RELEASE === '1';
const ON_IOS_SIM = ON_IOS && iosTarget() === 'simulator';
const HAS_COMPOSED_MAP =
  process.env.BUGSEE_COMPOSED_MAP !== undefined && process.env.BUGSEE_COMPOSED_MAP !== '';
/**
 * Simulator `logException` is compiled out, so it cannot report `debug_ids`.
 * An iOS device run reads whatever map `BUGSEE_COMPOSED_MAP` names; without
 * that path the describe is skipped rather than opening the Android map.
 */
const describeReleaseProof =
  RELEASE && (ON_ANDROID || (ON_IOS && !ON_IOS_SIM && HAS_COMPOSED_MAP)) ? describe : describe.skip;

jest.setTimeout(20 * 60_000);

let log: DeviceLog;

interface JsPayload {
  readonly reason?: unknown;
  readonly frames?: ReadonlyArray<{ readonly debug_id?: unknown }>;
  readonly debug_ids?: unknown;
}

function composedMapPath(): string {
  const override = process.env.BUGSEE_COMPOSED_MAP;
  if (override !== undefined && override !== '') {
    return override;
  }
  return join(
    __dirname,
    '..',
    'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map',
  );
}

/** `debug_id` on the composed map. `debugId` must be the same UUID. */
function debugIdOfComposedMap(mapPath: string): string {
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
    debug_id?: unknown;
    debugId?: unknown;
  };
  if (typeof map.debug_id !== 'string' || !UUID_RE.test(map.debug_id)) {
    throw new Error(`composed map ${mapPath} has no debug_id UUID`);
  }
  if (map.debugId !== map.debug_id) {
    throw new Error(`composed map ${mapPath} debugId does not equal debug_id`);
  }
  return map.debug_id;
}

function payloadOf(bundle: PulledBundle): JsPayload {
  const crash = crashOf(bundle);
  if (crash === undefined) {
    throw new Error(`bundle ${bundle.file} has no crash capture`);
  }
  const exception = crash.exception;
  if (exception === null || typeof exception !== 'object') {
    throw new Error(`bundle ${bundle.file} crash.json has no exception object`);
  }
  const reason = (exception as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || !reason.startsWith('{')) {
    throw new Error(
      `bundle ${bundle.file} exception.reason is not JSON text: ${String(reason).slice(0, 120)}`,
    );
  }
  return JSON.parse(reason) as JsPayload;
}

describeReleaseProof(`composed debug id on ${TARGET_NAME} (release)`, () => {
  let run: Run;
  let nonce: string;
  let mapId: string;
  let payload: JsPayload;

  beforeAll(async () => {
    mapId = debugIdOfComposedMap(composedMapPath());
    report('composed map', composedMapPath());
    report('composed map debug_id', mapId);

    if (ON_IOS) {
      log = IosConsole.start();
      useLog(log, '13.5');
    } else {
      log = await Logcat.start();
      useLog(log, '13.5');
      await airplane(true);
    }
    await clearBundles();

    run = await startRun('exc-map-id');
    nonce = run.scenario.nonce;
    report('banner', run.banner.text.trim());
    expect(run.dev).toBe(false);

    must(
      await log.waitFor(
        new RegExp(`BUGSEE_E2E exc map-id-sent nonce=${nonce}`),
        30_000,
        run.launched.index,
      ),
      'the map-id-sent marker',
      run.start,
    );

    const bundles = await awaitBundles(1);
    report(
      'bundle files',
      bundles.map(b => b.file),
    );
    const matches = bundles.filter(bundle => {
      try {
        return payloadOf(bundle).reason === `E2E map-id ${nonce}`;
      } catch {
        return false;
      }
    });
    expect(matches).toHaveLength(1);
    payload = payloadOf(matches[0]!);
    report('runtime debug_ids', payload.debug_ids);
  });

  afterAll(async () => {
    if (!RELEASE || ON_IOS_SIM || (!ON_ANDROID && !ON_IOS)) {
      return;
    }
    try {
      if (ON_ANDROID) {
        await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE).catch(() => {});
      }
    } finally {
      try {
        if (ON_ANDROID) {
          await airplane(false);
        }
      } finally {
        try {
          await clearBundles().catch((error: unknown) => report('cleanup clear failed', String(error)));
        } finally {
          try {
            const { removed, kept } = removePulledBundles();
            report('pulled bundle roots', { removed: removed.length, kept });
          } finally {
            try {
              if (log !== undefined) {
                log.stop();
              }
            } finally {
              resetScenario();
            }
          }
        }
      }
    }
  });

  it('the release bundle reports the composed map debug id', () => {
    const ids = payload.debug_ids;
    expect(ids).toEqual(expect.any(Object));
    expect(Array.isArray(ids)).toBe(false);
    const values = Object.values(ids as Record<string, unknown>);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBe(mapId);
    }
    for (const frame of payload.frames ?? []) {
      if (frame.debug_id !== undefined) {
        expect(frame.debug_id).toBe(mapId);
      }
    }
    report('matched', { runtime: values, map: mapId });
  });
});
