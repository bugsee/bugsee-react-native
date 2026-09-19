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

  it('the Android module is the bus sink and detaches on invalidate', () => {
    const source = pkg(
      'android', 'src', 'main', 'java', 'com', 'bugsee', 'reactnative', 'BugseeModule.java',
    );
    expect(source).toMatch(/implements\s+WrapperEventBus\.Sink/);
    expect(source).toMatch(/public void invalidate\(\)/);
    expect(source).toMatch(/detach\(this\)/);
  });
});
