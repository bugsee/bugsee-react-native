import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseBlockers } from '../releasable-pins';
import { readNativeVersions, type NativeVersions } from '../native-versions';

const RESOLVED_REAL_REVISION = JSON.stringify({
  pins: [
    {
      identity: 'spm',
      kind: 'remoteSourceControl',
      location: 'https://github.com/bugsee/spm',
      state: {
        revision: 'cfcb244fdb1e6052ff16bad65e5b84757f3a2b04',
        version: '7.0.0-beta2',
      },
    },
  ],
  version: 2,
});

const RESOLVED_PLACEHOLDER_REVISION = JSON.stringify({
  pins: [
    {
      identity: 'spm',
      kind: 'remoteSourceControl',
      location: 'https://github.com/bugsee/spm',
      state: {
        revision: '0000000000000000000000000000000000000000',
        version: '7.0.0-beta3',
      },
    },
  ],
  version: 2,
});

const releasable: NativeVersions = {
  android: { sdk: '7.3.0', gradlePlugin: '4.0.7' },
  ios: { sdk: '7.0.0-beta2', spmUrl: 'https://github.com/bugsee/spm' },
};

describe('releaseBlockers', () => {
  it('a SNAPSHOT android pin is a release blocker', () => {
    const versions: NativeVersions = {
      ...releasable,
      android: {
        ...releasable.android,
        sdk: '7.3.0-SNAPSHOT',
        snapshotCommit: '234dcddfcb972da008eeeb0e3ad8757e27ba3e50',
      },
    };
    const blockers = releaseBlockers(versions, RESOLVED_REAL_REVISION);
    // Two blockers here: the SNAPSHOT pin itself, and the snapshotCommit that
    // comes with it. This test is about the first.
    expect(blockers).toContainEqual(
      expect.stringMatching(/^android\.sdk is pinned to 7\.3\.0-SNAPSHOT, a local SNAPSHOT build -- not a released Bugsee SDK\.$/),
    );
  });

  it('snapshotCommit alone is a release blocker', () => {
    // Not a state readNativeVersions would ever hand back (it enforces the
    // pairing), but releaseBlockers takes a plain NativeVersions and must not
    // rely on that validation having already run.
    const versions: NativeVersions = {
      ...releasable,
      android: {
        ...releasable.android,
        sdk: '7.3.0',
        snapshotCommit: '234dcddfcb972da008eeeb0e3ad8757e27ba3e50',
      },
    };
    const blockers = releaseBlockers(versions, RESOLVED_REAL_REVISION);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toBe(
      'android.snapshotCommit (234dcddfcb972da008eeeb0e3ad8757e27ba3e50) is set. ' +
        'It only has meaning while android.sdk is a SNAPSHOT built from that ' +
        'commit; a release must not carry it.',
    );
  });

  it('the zero-revision Package.resolved placeholder is a release blocker', () => {
    const blockers = releaseBlockers(releasable, RESOLVED_PLACEHOLDER_REVISION);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toBe(
      'ios/Support/Package.resolved pins spm to the placeholder revision ' +
        '0000000000000000000000000000000000000000, not a commit that was actually resolved.',
    );
  });

  it('7.3.0 with a real revision has no blockers', () => {
    expect(releaseBlockers(releasable, RESOLVED_REAL_REVISION)).toEqual([]);
  });

  it('finds the spm pin regardless of where it sits in the pins array', () => {
    const resolvedWithSpmSecond = JSON.stringify({
      pins: [
        {
          identity: 'not-spm-at-all',
          kind: 'remoteSourceControl',
          location: 'https://github.com/example/unrelated',
          state: { revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', version: '1.0.0' },
        },
        {
          identity: 'spm',
          kind: 'remoteSourceControl',
          location: 'https://github.com/bugsee/spm',
          state: { revision: '0000000000000000000000000000000000000000', version: '7.0.0-beta3' },
        },
      ],
      version: 2,
    });
    expect(releaseBlockers(releasable, resolvedWithSpmSecond)).toHaveLength(1);
  });

  it('a spm pin with no state at all is not mistaken for the placeholder', () => {
    const resolvedNoState = JSON.stringify({
      pins: [{ identity: 'spm', kind: 'remoteSourceControl', location: 'https://github.com/bugsee/spm' }],
      version: 2,
    });
    expect(() => releaseBlockers(releasable, resolvedNoState)).not.toThrow();
    expect(releaseBlockers(releasable, resolvedNoState)).toEqual([]);
  });

  it('no spm pin at all does not crash', () => {
    const resolvedNoSpmPin = JSON.stringify({
      pins: [
        {
          identity: 'not-spm-at-all',
          kind: 'remoteSourceControl',
          location: 'https://github.com/example/unrelated',
          state: { revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', version: '1.0.0' },
        },
      ],
      version: 2,
    });
    expect(() => releaseBlockers(releasable, resolvedNoSpmPin)).not.toThrow();
    expect(releaseBlockers(releasable, resolvedNoSpmPin)).toEqual([]);
  });

  it('ignores a non-string version value rather than crashing on it', () => {
    // native-versions.ts's own validation rejects this shape; releaseBlockers
    // is defensive on its own, since it does not require that validation to
    // have run first.
    const versions = {
      ...releasable,
      android: { ...releasable.android, gradlePlugin: 4 as unknown as string },
    };
    expect(() => releaseBlockers(versions, RESOLVED_REAL_REVISION)).not.toThrow();
    expect(releaseBlockers(versions, RESOLVED_REAL_REVISION)).toEqual([]);
  });

  // Runs only under `BUGSEE_RELEASE=1 yarn test`. It is the gate itself: the
  // repo's committed native-versions.json + Package.resolved must have zero
  // blockers before a release, and right now (a SNAPSHOT Android pin) it does
  // not -- so this is expected to fail until Task 3.P3 flips the pin.
  (process.env.BUGSEE_RELEASE === '1' ? it : it.skip)(
    'the committed pins are releasable',
    () => {
      const versions = readNativeVersions();
      const resolved = readFileSync(
        join(__dirname, '..', '..', 'packages/react-native/ios/Support/Package.resolved'),
        'utf8',
      );
      expect(releaseBlockers(versions, resolved)).toEqual([]);
    },
  );
});
