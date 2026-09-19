import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(__dirname, '..', '..');
const pkg = (...p: string[]) =>
  readFileSync(join(repo, 'packages', 'react-native', ...p), 'utf8');

const manifest = () => pkg('android', 'src', 'main', 'AndroidManifest.xml');

const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`android:${name}\\s*=\\s*"([^"]*)"`).exec(xml)?.[1];

/**
 * The Bugsee Gradle plugin's own rule for which `<provider>` entries it strips
 * from the merged manifest, copied verbatim from ManifestModifier.kt so a
 * change on their side shows up here as a disagreement rather than silently.
 *
 * It strips a match and compensates by injecting the extension's
 * `register<Name>Extension()` into BugseeInitProvider.initializeExtensions().
 * We are not an SDK extension and have no such method, so a name that matches
 * would be removed with nothing put back -- the provider would vanish from the
 * APK and the wrapper would never register, with a green build and no warning.
 */
const PLUGIN_STRIPS = /^.*\.Bugsee[A-Za-z0-9_]+InitProvider$/;

/** The core SDK's own provider, which ours must beat to the punch. */
const SDK_INIT_ORDER = 100;

describe('the wrapper registers before the SDK can launch', () => {
  // AGP is otherwise the first thing to notice, and it reports this as
  // "Error parsing AndroidManifest.xml" from deep inside a library manifest
  // merge, with no line number. The trap that produced it: "--" is illegal
  // inside an XML comment, and the explanation above the provider is long.
  it('is well-formed XML', () => {
    const xml = manifest();
    for (const comment of xml.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment.slice(4, -3)).not.toContain('--');
    }
    expect(xml.match(/<provider\b/g) ?? []).toHaveLength(1);
  });

  it('declares a ContentProvider', () => {
    expect(manifest()).toMatch(/<provider\b/);
  });

  // BugseeInitProvider is a ContentProvider, so under auto-init the SDK
  // launches before Application.onCreate -- before any app code, before React
  // Native exists. A provider is the only hook that can run earlier, and only
  // if it wins the ordering: providers start in DESCENDING initOrder.
  it('runs before the SDK provider', () => {
    const order = Number(attr(manifest(), 'initOrder'));
    expect(Number.isInteger(order)).toBe(true);
    expect(order).toBeGreaterThan(SDK_INIT_ORDER);
  });

  it('is not named so the Bugsee Gradle plugin strips it', () => {
    const name = attr(manifest(), 'name');
    expect(name).toBeDefined();
    expect(PLUGIN_STRIPS.test(name as string)).toBe(false);
  });

  // Two apps on one device, or our provider and the SDK's, cannot share an
  // authority: the second install fails outright with INSTALL_FAILED_CONFLICTING_PROVIDER.
  it('scopes its authority to the installing app', () => {
    const authority = attr(manifest(), 'authorities');
    expect(authority).toContain('${applicationId}');
    expect(authority).not.toContain('bugseeinitprovider');
  });

  it('exports nothing -- it is an init hook, not content', () => {
    expect(attr(manifest(), 'exported')).toBe('false');
  });

  // The base class wires BugseeContextProvider before our body runs; without
  // it, anything we touch that reads the global context sees null and degrades
  // silently (the SDK's own doc calls out in-memory preferences as the trap).
  it('extends the SDK base class rather than ContentProvider directly', () => {
    const src = pkg(
      'android', 'src', 'main', 'java', 'com', 'bugsee', 'reactnative',
      'ReactNativeWrapperInitProvider.java',
    );
    expect(src).toMatch(/extends\s+BugseeExtensionInitProviderBase\b/);
    expect(src).toMatch(/Bugsee\.setWrapper\(/);
  });
});

// The native registration cannot ask JS what wrapper this is, so the type
// string exists twice. Two spellings would register two different wrappers
// depending on how far start-up got -- the early report saying one thing and
// every later report another.
describe('the wrapper type is one value, not two', () => {
  it('the Java constant matches identity.ts', () => {
    const ts = /export const WRAPPER_TYPE = '([^']+)'/
      .exec(pkg('src', 'wrapper', 'identity.ts'))?.[1];
    const java = /String WRAPPER_TYPE = "([^"]+)"/
      .exec(pkg('android', 'src', 'main', 'java', 'com', 'bugsee', 'reactnative',
        'BugseeReactNativeWrapper.java'))?.[1];

    expect(ts).toBeDefined();
    expect(java).toBe(ts);
  });
});

// The probe was scaffolding for establishing the contract on a device. It logs
// on getSecureRectangles, which the SDK pulls at 2-3 Hz -- 281 lines in a
// 40-second run -- so leaving it in ships a wrapper that floods logcat.
describe('the bring-up probe is gone', () => {
  it.each([
    ['android/src/main/java/com/bugsee/reactnative/BugseeReactNativeWrapper.java'],
    ['android/src/main/java/com/bugsee/reactnative/BugseeModule.java'],
    ['ios/BugseeModule.mm'],
  ])('%s carries no probe logging', (relative) => {
    const src = pkg(...relative.split('/'));
    expect(src).not.toMatch(/BUGSEE_WRAPPER|BGSRNProbe/);
  });
});
