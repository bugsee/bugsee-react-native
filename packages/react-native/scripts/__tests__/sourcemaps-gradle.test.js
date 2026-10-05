'use strict';

// Runs the real scripts/bugsee-sourcemaps.gradle in a real Gradle build whose
// AGP and React Native pieces are stand-ins: an `androidComponents` with
// variants, and a bundle task type with BundleHermesCTask's properties. A
// stand-in hermes-sourcemaps.js records the argv the hook passes.
//
// Gradle is slow to start and needs a JDK, so this file runs only with
// BUGSEE_GRADLE_TESTS=1 (the CI android job sets it).

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

const REPO = path.join(__dirname, '..', '..', '..', '..');
const GRADLEW = path.join(REPO, 'examples', 'bare', 'android', 'gradlew');
const HOOK = path.join(__dirname, '..', 'bugsee-sourcemaps.gradle');
const ENABLED = process.env.BUGSEE_GRADLE_TESTS === '1';

const BUILD_GRADLE = `
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

abstract class FakeBundle extends DefaultTask {
    @Internal abstract Property<String> getBundleAssetName()
    @Internal abstract DirectoryProperty getJsBundleDir()
    @Internal abstract DirectoryProperty getJsSourceMapsDir()
    @Internal abstract DirectoryProperty getJsIntermediateSourceMapsDir()
    @Internal abstract DirectoryProperty getReactNativeDir()
    @Internal abstract ListProperty<String> getNodeExecutableAndArgs()
    @Internal abstract Property<Boolean> getHermesEnabled()
    @Internal abstract ListProperty<String> getHermesFlags()
    @TaskAction void run() {}
}

class FakeSelector { FakeSelector all() { this } }
class FakeOutput { Property<String> versionName; Property<Integer> versionCode }
class FakeVariant { String name; List<FakeOutput> outputs }
class FakeComponents {
    List<FakeVariant> variants = []
    FakeSelector selector() { new FakeSelector() }
    void onVariants(FakeSelector selector, Closure action) { variants.each { action.call(it) } }
}

def output = { String name, Integer code ->
    def o = new FakeOutput(versionName: objects.property(String), versionCode: objects.property(Integer))
    if (name != null) o.versionName.set(name)
    if (code != null) o.versionCode.set(code)
    o
}
def components = new FakeComponents()
// Versioned only on the flavor: defaultConfig would have neither value.
components.variants << new FakeVariant(name: 'freeRelease', outputs: [output('2.1-free', 0)])
components.variants << new FakeVariant(name: 'paidRelease', outputs: [output('3.0', 7)])
components.variants << new FakeVariant(name: 'brokenRelease', outputs: [output('4.0', 4)])
components.variants << new FakeVariant(name: 'noversionRelease', outputs: [output(null, null)])
components.variants << new FakeVariant(name: 'release', outputs: [output('1.0', 1), output('1.0', 1001)])
// A flavor declared with a capital: AGP keeps the variant name, the task name is the same.
components.variants << new FakeVariant(name: 'StagingRelease', outputs: [output('5.0', 5)])
components.variants << new FakeVariant(name: 'customRelease', outputs: [output('6.0', 6)])
extensions.add('androidComponents', components)

apply from: 'scripts/bugsee-sourcemaps.gradle'
// A second apply (a bare app that copied the example and followed the README) is a no-op.
apply from: 'scripts/bugsee-sourcemaps.gradle'

def bundle = { String variant, boolean hermes, String bundleDir = null ->
    def cap = variant.substring(0, 1).toUpperCase() + variant.substring(1)
    tasks.register("createBundle\${cap}JsAndAssets", FakeBundle) { t ->
        t.bundleAssetName.set('index.android.bundle')
        t.jsBundleDir.set(layout.buildDirectory.dir(bundleDir ?: "generated/assets/react/\${variant}"))
        t.jsSourceMapsDir.set(layout.buildDirectory.dir("generated/sourcemaps/react/\${variant}"))
        t.jsIntermediateSourceMapsDir.set(layout.buildDirectory.dir("intermediates/sourcemaps/react/\${variant}"))
        t.reactNativeDir.set(layout.projectDirectory.dir('rn'))
        t.nodeExecutableAndArgs.set([findProperty('nodePath').toString()])
        t.hermesEnabled.set(hermes)
        t.hermesFlags.set(['-O', '-output-source-map'])
    }
}
bundle('freeRelease', true)
bundle('paidRelease', false)
bundle('brokenRelease', true)
bundle('noversionRelease', false)
bundle('release', false)
bundle('StagingRelease', false)
// Outside generated/assets: no preserve directory to map to, and none needed with Hermes off.
bundle('customRelease', false, 'custom/js')
`;

// Records argv, then does what finish would to the files it was given.
const FAKE_FINISH = `
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(__dirname, '..', 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
`;

function argOf(argv, name) {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

(ENABLED ? describe : describe.skip)('bugsee-sourcemaps.gradle in a Gradle build', () => {
  let dir;
  let result;
  let calls;

  const assets = (variant) => path.join(dir, 'build/generated/assets/react', variant);
  const preserve = (variant) => path.join(dir, 'build/intermediates/bugsee-sourcemaps/react', variant);
  const callFor = (where) =>
    calls.find((argv) => argOf(argv, '--bundle').includes(where.includes('/') ? `/${where}/` : `/react/${where}/`));

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-gradle-hook-')));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(HOOK, path.join(dir, 'scripts', 'bugsee-sourcemaps.gradle'));
    fs.writeFileSync(path.join(dir, 'scripts', 'hermes-sourcemaps.js'), FAKE_FINISH);
    fs.writeFileSync(path.join(dir, 'settings.gradle'), "rootProject.name = 'bugsee-hook-fixture'\n");
    fs.writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx512m\n');
    fs.writeFileSync(path.join(dir, 'build.gradle'), BUILD_GRADLE);
    for (const variant of ['freeRelease', 'paidRelease', 'brokenRelease', 'noversionRelease', 'release', 'StagingRelease']) {
      fs.mkdirSync(assets(variant), { recursive: true });
      fs.writeFileSync(path.join(assets(variant), 'index.android.bundle'), 'bundle');
      fs.writeFileSync(path.join(assets(variant), 'index.android.bundle.bugsee-recompile'), 'stale copy');
    }
    fs.mkdirSync(path.join(dir, 'build/custom/js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build/custom/js/index.android.bundle'), 'bundle');
    // Hermes on, through the wrapper: preserved JS and the hermesc note.
    fs.mkdirSync(preserve('freeRelease'), { recursive: true });
    fs.writeFileSync(path.join(preserve('freeRelease'), 'index.android.bundle.bugsee-js-source'), 'js');
    fs.writeFileSync(path.join(preserve('freeRelease'), 'index.android.bundle.bugsee-hermesc'), '/opt/hermesc\n');
    // Hermes off with a stale preserve file from an earlier Hermes build.
    fs.mkdirSync(preserve('paidRelease'), { recursive: true });
    fs.writeFileSync(path.join(preserve('paidRelease'), 'index.android.bundle.bugsee-js-source'), 'stale');

    result = cp.spawnSync(
      GRADLEW,
      [
        '-p',
        dir,
        '--no-daemon',
        '--continue',
        '--console=plain',
        `-PnodePath=${process.execPath}`,
        '-PbugseeUploadSourcemaps=false',
        'createBundleFreeReleaseJsAndAssets',
        'createBundlePaidReleaseJsAndAssets',
        'createBundleBrokenReleaseJsAndAssets',
        'createBundleNoversionReleaseJsAndAssets',
        'createBundleReleaseJsAndAssets',
        'createBundleStagingReleaseJsAndAssets',
        'createBundleCustomReleaseJsAndAssets',
      ],
      { encoding: 'utf8', timeout: 10 * 60 * 1000 },
    );
    const log = path.join(dir, 'calls.jsonl');
    calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
  }, 11 * 60 * 1000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes the owning variant version, flavor-only and versionCode 0 included', () => {
    const free = callFor('freeRelease');
    expect(argOf(free, '--app-version')).toBe('2.1-free');
    expect(argOf(free, '--app-build')).toBe('0');
    expect(argOf(callFor('paidRelease'), '--app-version')).toBe('3.0');
    expect(argOf(callFor('paidRelease'), '--app-build')).toBe('7');
    // A plain `release` variant, and the first output when splits add more.
    expect(argOf(callFor('release'), '--app-version')).toBe('1.0');
    expect(argOf(callFor('release'), '--app-build')).toBe('1');
    // A capitalised flavor keeps its version lookup.
    expect(argOf(callFor('StagingRelease'), '--app-version')).toBe('5.0');
    expect(argOf(callFor('StagingRelease'), '--app-build')).toBe('5');
    // No version anywhere: empty, and the upload gate says so.
    expect(argOf(callFor('noversionRelease'), '--app-version')).toBe('');
    expect(argOf(callFor('noversionRelease'), '--app-build')).toBe('');
  });

  it('finishes a Hermes bundle from the preserved JS and cleans every preserve file', () => {
    const free = callFor('freeRelease');
    expect(free[0]).toBe('finish');
    expect(argOf(free, '--bundle')).toBe(path.join(preserve('freeRelease'), 'index.android.bundle.bugsee-js-source'));
    expect(argOf(free, '--bytecode')).toBe(path.join(assets('freeRelease'), 'index.android.bundle'));
    expect(argOf(free, '--compose')).toBe(path.join(dir, 'rn', 'scripts', 'compose-source-maps.js'));
    expect(argOf(free, '--hermesc')).toBe('/opt/hermesc');
    expect(free.filter((_, i) => free[i - 1] === '--hermes-arg')).toEqual(['-O', '-output-source-map']);
    expect(argOf(free, '--upload-sourcemaps')).toBe('false');
    expect(argOf(free, '--platform')).toBe('android');
    expect(argOf(free, '--properties')).toBe(path.join(dir, 'bugsee.properties'));
    expect(fs.readdirSync(preserve('freeRelease'))).toEqual([]);
    expect(fs.readdirSync(assets('freeRelease'))).toEqual(['index.android.bundle']);
  });

  it('with Hermes off injects into the packaged bundle and Metro map, ignoring a stale preserve', () => {
    const paid = callFor('paidRelease');
    expect(paid[0]).toBe('finish');
    expect(argOf(paid, '--bundle')).toBe(path.join(assets('paidRelease'), 'index.android.bundle'));
    expect(argOf(paid, '--composed')).toBe(
      path.join(dir, 'build/generated/sourcemaps/react/paidRelease/index.android.bundle.map'),
    );
    for (const flag of ['--bytecode', '--compose', '--intermediate', '--packager', '--hermesc', '--hermes-arg']) {
      expect(paid).not.toContain(flag);
    }
    expect(argOf(paid, '--upload-sourcemaps')).toBe('false');
    expect(fs.readdirSync(preserve('paidRelease'))).toEqual([]);
  });

  it('fails the bundle task when Hermes is on and hermesc skipped the preserve wrapper', () => {
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(
      'Bugsee: createBundleBrokenReleaseJsAndAssets compiled the bundle with Hermes, but hermesc did not run through hermesc-preserve-js.sh',
    );
    expect(output).toContain('hermesCommand');
    expect(output).toContain('"Android source maps"');
    expect(calls.some((argv) => argOf(argv, '--bundle').includes('/react/brokenRelease/'))).toBe(false);
    // Only that task failed; --continue ran the other six, each once although
    // the script was applied twice.
    expect(calls).toHaveLength(6);
    expect(output.match(/compiled the bundle with Hermes/g)).toHaveLength(1);
  });

  it('applied twice, finishes a correctly wired Hermes bundle once', () => {
    expect(calls.filter((argv) => argOf(argv, '--bundle').includes('/react/freeRelease/'))).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('createBundleFreeReleaseJsAndAssets FAILED');
  });

  it('finishes a Hermes-off bundle outside generated/assets', () => {
    const custom = callFor('custom/js');
    expect(argOf(custom, '--bundle')).toBe(path.join(dir, 'build/custom/js/index.android.bundle'));
    expect(argOf(custom, '--app-version')).toBe('6.0');
  });
});
