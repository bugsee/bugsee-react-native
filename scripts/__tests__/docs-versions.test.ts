import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readNativeVersions } from '../native-versions';
import {
  checkDocsVersions,
  parseDesignGoals,
  parsePlanGlobalConstraints,
  stripSnapshot,
} from '../docs-versions';

const root = join(__dirname, '..', '..');
const plan = readFileSync(
  join(root, 'docs/design/plans/2026-09-16-implementation-plan.md'),
  'utf8',
);
const design = readFileSync(join(root, 'docs/design/2026-09-15-sdk-design.md'), 'utf8');
const versions = readNativeVersions();

describe('stripSnapshot', () => {
  it('removes a trailing -SNAPSHOT', () => {
    expect(stripSnapshot('7.3.0-SNAPSHOT')).toBe('7.3.0');
  });

  it('leaves a released version untouched', () => {
    expect(stripSnapshot('7.3.0')).toBe('7.3.0');
  });
});

describe("the plan's Global Constraints name the pinned Android, plugin and iOS versions", () => {
  it('matches native-versions.json, with the Android SNAPSHOT suffix stripped', () => {
    const parsed = parsePlanGlobalConstraints(plan);
    expect(parsed.androidSdk).toBe(stripSnapshot(versions.android.sdk));
    expect(parsed.gradlePlugin).toBe(versions.android.gradlePlugin);
    expect(parsed.iosSdk).toBe(versions.ios.sdk);
  });
});

describe("the design's Goals name the same", () => {
  it('matches native-versions.json, with the Android SNAPSHOT suffix stripped', () => {
    const parsed = parseDesignGoals(design);
    expect(parsed.androidSdk).toBe(stripSnapshot(versions.android.sdk));
    expect(parsed.iosSdk).toBe(versions.ios.sdk);
  });
});

describe('checkDocsVersions', () => {
  it('passes for the live docs against the live pins', () => {
    expect(checkDocsVersions(plan, design, versions)).toEqual({ ok: true });
  });

  // These exercise the checker function itself with a deliberately wrong
  // pin, rather than only relying on the live docs ever drifting again --
  // per the brief, a docs-only task does not get to break a committed file
  // just to prove its own test bites.
  it('fails when the ios pin the checker is given does not match beta3', () => {
    const wrongIos: typeof versions = { ...versions, ios: { ...versions.ios, sdk: '7.0.0-beta1' } };
    const result = checkDocsVersions(plan, design, wrongIos);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/iOS SDK/);
  });

  it('fails when the android pin does not match, SNAPSHOT or not', () => {
    const wrongAndroid: typeof versions = {
      ...versions,
      android: { sdk: '7.2.0', gradlePlugin: versions.android.gradlePlugin },
    };
    const result = checkDocsVersions(plan, design, wrongAndroid);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/Android SDK/);
  });

  it('fails when the gradle plugin pin does not match', () => {
    const wrongPlugin: typeof versions = {
      ...versions,
      android: { ...versions.android, gradlePlugin: '4.0.6' },
    };
    const result = checkDocsVersions(plan, design, wrongPlugin);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/Gradle plugin/);
  });

  // A correct android pin masked by a wrong SNAPSHOT stripping would be a
  // silent false pass; this pins that the comparison happens AFTER stripping.
  it('still passes when the live android pin is a SNAPSHOT that strips to the expected release', () => {
    const asSnapshot: typeof versions = {
      ...versions,
      android: {
        ...versions.android,
        sdk: `${stripSnapshot(versions.android.sdk)}-SNAPSHOT`,
        snapshotCommit: versions.android.snapshotCommit ?? '0'.repeat(40),
      },
    };
    expect(checkDocsVersions(plan, design, asSnapshot)).toEqual({ ok: true });
  });
});

describe('parsePlanGlobalConstraints / parseDesignGoals', () => {
  it('names what is missing when the plan bullet is not found', () => {
    expect(() => parsePlanGlobalConstraints('nothing here')).toThrow(/Android SDK/);
  });

  it('names what is missing when the design bullet is not found', () => {
    expect(() => parseDesignGoals('nothing here')).toThrow(/Goals/i);
  });

  it('rejects a Goals line with fewer than two bolded versions', () => {
    expect(() => parseDesignGoals('- Ship a 7.x-native React Native SDK for **one** thing.'))
      .toThrow(/expected two bolded versions/);
  });
});
