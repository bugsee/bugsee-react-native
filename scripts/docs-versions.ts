/**
 * Keeps the design doc and the implementation plan honest about which native
 * versions this wrapper is actually built against. Both documents restate the
 * pins in prose for a human reader; nothing enforced that restatement, so it
 * drifted (the plan still named Android 7.2.0 and iOS 7.0.0-beta1 well after
 * Phase 3 moved the real pins to 7.3.0-SNAPSHOT and 7.0.0-beta3).
 *
 * This does not replace `native-versions.json` as the single source -- it
 * only asserts the two documents that restate it in English have not fallen
 * behind it.
 */
import type { NativeVersions } from './native-versions';

/**
 * A `-SNAPSHOT` pin is transitional (Phase 3's rulings): the docs describe the
 * SDK the wrapper is built against, which is the release the SNAPSHOT stands
 * in for, not the local-build suffix. Stripping it is the documented rule,
 * not a loophole -- `native-versions.ts` still requires `snapshotCommit`
 * alongside the suffix, so the transitional state stays traceable there.
 */
export function stripSnapshot(version: string): string {
  return version.replace(/-SNAPSHOT$/, '');
}

export interface PlanVersions {
  androidSdk: string;
  gradlePlugin: string;
  iosSdk: string;
}

export interface DesignVersions {
  androidSdk: string;
  iosSdk: string;
}

// Anchored on the fixed part of each bullet in "## Global Constraints" --
// the reasoning prose around the versions is expected to change (that's the
// whole point of the section), so the pattern only pins the structural text
// that names the version.
// The reasoning prose between "Android SDK **x**" and "Gradle plugin **y**" is
// expected to change (that's the whole point of the section, and it grew a
// parenthetical explaining the transitional SNAPSHOT in Task 3.6) -- `[^\n]*`
// only requires both to land on the same bullet, not adjacently.
const PLAN_ANDROID_AND_PLUGIN =
  /Android SDK \*\*([^*]+)\*\*[^\n]*Gradle plugin \*\*([^*]+)\*\*/;
const PLAN_IOS = /iOS SDK \*\*([^*]+)\*\* from `https:\/\/github\.com\/bugsee\/spm`/;

/** The versions named in the plan's "## Global Constraints" section. */
export function parsePlanGlobalConstraints(plan: string): PlanVersions {
  const androidMatch = PLAN_ANDROID_AND_PLUGIN.exec(plan);
  if (!androidMatch) {
    throw new Error(
      'plan Global Constraints: no "Android SDK **x** ... Gradle plugin **y**" bullet found',
    );
  }
  const iosMatch = PLAN_IOS.exec(plan);
  if (!iosMatch) {
    throw new Error(
      'plan Global Constraints: no "iOS SDK **x** from `https://github.com/bugsee/spm`" bullet found',
    );
  }
  return {
    androidSdk: androidMatch[1] as string,
    gradlePlugin: androidMatch[2] as string,
    iosSdk: iosMatch[1] as string,
  };
}

// The Goals bullet's exact wording changes with the versions it reports (see
// Task 3.6), so this reads the first two bolded tokens on the "Ship a
// 7.x-native..." line rather than pin the sentence around them -- Android's
// version is always named before iOS's, on that one line.
const DESIGN_GOALS_LINE = /^- Ship a 7\.x-native React Native SDK.*$/m;
const BOLDED = /\*\*([^*]+)\*\*/g;

/** The versions named in the design's "## 2. Goals" section. */
export function parseDesignGoals(design: string): DesignVersions {
  const line = DESIGN_GOALS_LINE.exec(design)?.[0];
  if (!line) {
    throw new Error(
      'design Goals: no "Ship a 7.x-native React Native SDK..." bullet found',
    );
  }
  const bolded = [...line.matchAll(BOLDED)].map((m) => m[1] as string);
  if (bolded.length < 2) {
    throw new Error(
      `design Goals: expected two bolded versions (Android, iOS) on the Goals line, found ${bolded.length}: ${JSON.stringify(line)}`,
    );
  }
  return { androidSdk: bolded[0] as string, iosSdk: bolded[1] as string };
}

export type DocsVersionsResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks that both documents name the same native versions `native-versions`
 * pins, `-SNAPSHOT` stripped on the Android side. Takes `versions` as a
 * parameter (rather than reading `native-versions.json` itself) so it can be
 * exercised against a deliberately wrong pin -- see `docs-versions.test.ts`'s
 * mutation cases.
 */
export function checkDocsVersions(
  plan: string,
  design: string,
  versions: NativeVersions,
): DocsVersionsResult {
  const expectedAndroid = stripSnapshot(versions.android.sdk);
  const expectedPlugin = versions.android.gradlePlugin;
  const expectedIos = versions.ios.sdk;

  const planVersions = parsePlanGlobalConstraints(plan);
  if (planVersions.androidSdk !== expectedAndroid) {
    return {
      ok: false,
      reason: `plan names Android SDK ${planVersions.androidSdk}, expected ${expectedAndroid}`,
    };
  }
  if (planVersions.gradlePlugin !== expectedPlugin) {
    return {
      ok: false,
      reason: `plan names Gradle plugin ${planVersions.gradlePlugin}, expected ${expectedPlugin}`,
    };
  }
  if (planVersions.iosSdk !== expectedIos) {
    return {
      ok: false,
      reason: `plan names iOS SDK ${planVersions.iosSdk}, expected ${expectedIos}`,
    };
  }

  const designVersions = parseDesignGoals(design);
  if (designVersions.androidSdk !== expectedAndroid) {
    return {
      ok: false,
      reason: `design names Android SDK ${designVersions.androidSdk}, expected ${expectedAndroid}`,
    };
  }
  if (designVersions.iosSdk !== expectedIos) {
    return {
      ok: false,
      reason: `design names iOS SDK ${designVersions.iosSdk}, expected ${expectedIos}`,
    };
  }

  return { ok: true };
}
