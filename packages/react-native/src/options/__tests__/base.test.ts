import { BugseeLaunchOptions } from '../BugseeLaunchOptions';

// A minimal concrete subclass: the base is abstract, and the point of several
// of these tests is that a first-class accessor and setCustomOption write to
// the same place.
class TestOptions extends BugseeLaunchOptions {
  get probe(): boolean | undefined {
    return this.$get('com.bugsee.option.probe');
  }
  set probe(value: boolean | undefined) {
    this.$set('com.bugsee.option.probe', value);
  }

  get localOnly(): string | undefined {
    return this.$getLocal('bugsee.local.thing');
  }
  set localOnly(value: string | undefined) {
    this.$setLocal('bugsee.local.thing', value);
  }
}

describe('setting and reading back', () => {
  it('round-trips a value through an accessor', () => {
    const o = new TestOptions();
    o.probe = true;
    expect(o.probe).toBe(true);
  });

  it('reads back undefined for a key never set', () => {
    expect(new TestOptions().probe).toBeUndefined();
  });

  it('keeps false distinct from unset', () => {
    const o = new TestOptions();
    o.probe = false;
    expect(o.probe).toBe(false);
    expect(BugseeLaunchOptions.serialize(o)).toEqual({
      'com.bugsee.option.probe': false,
    });
  });
});

describe('undefined deletes', () => {
  // Not "stores undefined": the serialized payload must not carry the key at
  // all, or the native side receives an explicit null for an option the
  // caller meant to leave alone, overriding the SDK's own default.
  it('removes the key from the payload entirely', () => {
    const o = new TestOptions();
    o.probe = true;
    o.probe = undefined;
    expect(o.probe).toBeUndefined();
    expect(BugseeLaunchOptions.serialize(o)).toEqual({});
    expect('com.bugsee.option.probe' in BugseeLaunchOptions.serialize(o))
      .toBe(false);
  });

  it('is a no-op when the key was never set', () => {
    const o = new TestOptions();
    o.probe = undefined;
    expect(BugseeLaunchOptions.serialize(o)).toEqual({});
  });
});

describe('setCustomOption', () => {
  // The whole reason the map is keyed by real 7.x keys: an option the wrapper
  // has not surfaced yet — including one added in a future 7.x patch — is
  // reachable without a wrapper release.
  it('reaches the same map as a first-class accessor', () => {
    const o = new TestOptions();
    o.setCustomOption('com.bugsee.option.probe', true);
    expect(o.probe).toBe(true);
  });

  it('is overwritten by a later accessor write, and vice versa', () => {
    const o = new TestOptions();
    o.setCustomOption('com.bugsee.option.probe', true);
    o.probe = false;
    expect(BugseeLaunchOptions.serialize(o)).toEqual({
      'com.bugsee.option.probe': false,
    });

    o.setCustomOption('com.bugsee.option.probe', true);
    expect(BugseeLaunchOptions.serialize(o)).toEqual({
      'com.bugsee.option.probe': true,
    });
  });

  it('carries a key the wrapper knows nothing about', () => {
    const o = new TestOptions();
    o.setCustomOption('com.bugsee.option.invented.later', 7);
    expect(BugseeLaunchOptions.serialize(o))
      .toEqual({ 'com.bugsee.option.invented.later': 7 });
  });

  it('deletes with undefined like any accessor', () => {
    const o = new TestOptions();
    o.setCustomOption('com.bugsee.option.invented.later', 7);
    o.setCustomOption('com.bugsee.option.invented.later', undefined);
    expect(BugseeLaunchOptions.serialize(o)).toEqual({});
  });
});

describe('$localOptions', () => {
  // JS-only settings for the wrapper's own components. If one reaches the
  // native payload the SDK rejects the launch or silently ignores it; either
  // way it is a key the native side never agreed to.
  it('never appears in the serialized payload', () => {
    const o = new TestOptions();
    o.localOnly = 'x';
    o.probe = true;
    expect(o.localOnly).toBe('x');
    expect(BugseeLaunchOptions.serialize(o)).toEqual({
      'com.bugsee.option.probe': true,
    });
  });

  it('is kept separate even when a local key collides with a native one', () => {
    const o = new TestOptions();
    o.setCustomOption('com.bugsee.option.probe', true);
    o['$setLocal']('com.bugsee.option.probe', 'local');
    expect(BugseeLaunchOptions.serialize(o)).toEqual({
      'com.bugsee.option.probe': true,
    });
    expect(o['$getLocal']('com.bugsee.option.probe')).toBe('local');
  });
});

describe('serialize', () => {
  it('returns a plain object, not the live map', () => {
    const o = new TestOptions();
    o.probe = true;
    const first = BugseeLaunchOptions.serialize(o);
    o.probe = false;
    expect(first).toEqual({ 'com.bugsee.option.probe': true });
  });

  it('returns an empty object for untouched options', () => {
    expect(BugseeLaunchOptions.serialize(new TestOptions())).toEqual({});
  });
});
