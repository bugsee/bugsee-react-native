import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = (...p: string[]) =>
  readFileSync(join(__dirname, '..', '..', 'packages', 'react-native', ...p), 'utf8');

const spec = pkg('src', 'NativeBugsee.ts');
const declaresAnEmitter = /:\s*EventEmitter</.test(spec);

/**
 * A spec that declares an `EventEmitter` needs more than a conforming module
 * on each platform, and neither requirement is obvious from the spec itself.
 *
 * On iOS codegen puts `emitOnLifecycleEvent:` on the generated
 * `NativeBugseeSpecBase` CLASS, not on the `NativeBugseeSpec` protocol. So a
 * module can conform to the protocol, compile as a TurboModule, and still be
 * unable to emit. The error you get is "no visible @interface for
 * 'BugseeModule' declares the selector", pointing at the call site rather than
 * at the superclass that is actually wrong.
 *
 * This is also invisible to every other gate: the ObjC unit tests build the
 * Support package, which has no codegen in it, so only an example build finds
 * it.
 */
describe('an EventEmitter in the spec is wired on both platforms', () => {
  it('the spec declares one (otherwise this file should be deleted)', () => {
    expect(declaresAnEmitter).toBe(true);
  });

  it('the iOS module inherits the generated base, not NSObject', () => {
    const header = pkg('ios', 'BugseeModule.h');
    expect(header).toMatch(/@interface\s+BugseeModule\s*:\s*NativeBugseeSpecBase\b/);
    expect(header).not.toMatch(/@interface\s+BugseeModule\s*:\s*NSObject\b/);
  });

  /**
   * The bridge has to release the bus on teardown, or a reload leaves the SDK
   * emitting into a dead module -- the classic React Native leak.
   */
  it('the iOS module detaches on invalidate', () => {
    const source = pkg('ios', 'BugseeModule.mm');
    expect(source).toMatch(/- \(void\)invalidate/);
    expect(source).toMatch(/detach:self/);
  });

  /**
   * The codegen emitter is a std::function the generated
   * `NativeBugseeSpecJSI` constructor sets. Attaching in `init` let the SDK
   * emit through it before `getTurboModule:` had built that object -- an
   * unset call -- and raced the SDK's thread reading the std::function
   * against the JS thread assigning it. So the module attaches only once the
   * JSI object exists: in `getTurboModule:`, after `make_shared`.
   */
  it('the iOS module attaches to the bus and bridge only after the emitter is set', () => {
    const source = pkg('ios', 'BugseeModule.mm');
    const body = (signature: RegExp): string => {
      const start = source.search(signature);
      expect(start).toBeGreaterThanOrEqual(0);
      const open = source.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
      }
      throw new Error('unbalanced braces');
    };
    // `init` may be gone entirely; if it exists it must not attach.
    if (/- \(instancetype\)init\b/.test(source)) {
      const init = body(/- \(instancetype\)init\b/);
      expect(init).not.toMatch(/attach:self/);
      expect(init).not.toMatch(/attachToBridges/);
    }

    const getTurboModule = body(/- \(std::shared_ptr<facebook::react::TurboModule>\)getTurboModule:/);
    const built = getTurboModule.search(/std::make_shared<facebook::react::NativeBugseeSpecJSI>/);
    const attached = getTurboModule.search(/\[self attachToBridges\]/);
    expect(built).toBeGreaterThanOrEqual(0);
    expect(attached).toBeGreaterThan(built);

    const attach = body(/- \(void\)attachToBridges\b/);
    expect(attach).toMatch(/BGSRNEventBus\.shared attach:self/);
    expect(attach).toMatch(/BGSRNReportHandlerBridge\.shared attach:self/);
  });

  it('the Android module is the bus sink and detaches on invalidate', () => {
    const source = pkg(
      'android', 'src', 'main', 'java', 'com', 'bugsee', 'reactnative', 'BugseeModule.java',
    );
    expect(source).toMatch(/implements\s+WrapperEventBus\.Sink/);
    expect(source).toMatch(/public void invalidate\(\)/);
    expect(source).toMatch(/detach\(this\)/);
  });

  it('setViewTreeEnabled is ignored unless the caller is the attached sink', () => {
    const ios = pkg('ios', 'BugseeModule.mm');
    expect(ios).toMatch(/setViewTreeEnabled:enabled forSink:self/);
    expect(ios).not.toMatch(/viewTreeEnabled\s*=/);

    const android = pkg(
      'android', 'src', 'main', 'java', 'com', 'bugsee', 'reactnative', 'BugseeModule.java',
    );
    expect(android).toMatch(/setViewTreeEnabled\(dataRequestSink, enabled\)/);
  });
});
