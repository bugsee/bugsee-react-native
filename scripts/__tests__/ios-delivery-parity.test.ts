import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, '..', '..', 'packages', 'react-native', 'ios', 'BugseeModule.mm'),
  'utf8',
);

/**
 * BugseeModule.mm imports the Support headers twice: angled and module-scoped
 * for SPM, quoted and flat for CocoaPods, chosen by __has_include.
 *
 * Only ONE of those branches compiles in any given build, so adding a header
 * to one and forgetting the other is invisible until someone builds the other
 * delivery. It cost a full example build to find the first time, and the error
 * it produces -- "use of undeclared identifier" at the USE site -- points
 * nowhere near the missing import.
 */
describe('both iOS delivery paths import the same headers', () => {
  const branches = /#if __has_include[\s\S]*?\n([\s\S]*?)\n#else\n([\s\S]*?)\n#endif/
    .exec(source);

  const names = (block: string): string[] =>
    [...block.matchAll(/#import [<"](?:BugseeRNSupport\/)?([A-Za-z0-9_]+\.h)[>"]/g)]
      .map((m) => m[1] as string)
      .sort();

  it('has both branches', () => {
    expect(branches).not.toBeNull();
  });

  it('imports an identical header set either way', () => {
    const [spm, cocoapods] = [branches?.[1] ?? '', branches?.[2] ?? ''];
    expect(names(cocoapods)).toEqual(names(spm));
  });

  it('imports at least the headers the module actually uses', () => {
    expect(names(branches?.[1] ?? '')).toContain('BGSRNSecureRectangles.h');
  });
});
