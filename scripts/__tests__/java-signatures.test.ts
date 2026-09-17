import { format, parseSignatures, unimplemented } from '../java-signatures';

const NAMES = ['launch', 'relaunch', 'stop', 'getStatus', 'testCrash'] as const;

// Shapes taken from the real generated spec and the real module.
const GENERATED = `
public abstract class NativeBugseeSpec extends ReactContextBaseJavaModule {
  @ReactMethod
  @DoNotStrip
  public abstract void launch(String token, ReadableMap options, Promise promise);
  public abstract void stop(Promise promise);
  public abstract void testCrash();
}`;

const IMPLEMENTED = `
public class BugseeModule extends NativeBugseeSpec {
  @Override
  public void launch(final String token, final ReadableMap options, final Promise promise) { }
  @Override
  public void stop(final Promise promise) { }
  @Override
  public void testCrash() { }
}`;

describe('parseSignatures', () => {
  it('keeps the parameter types and drops their names', () => {
    expect(parseSignatures(GENERATED, NAMES)).toEqual([
      { name: 'launch', parameters: ['String', 'ReadableMap', 'Promise'] },
      { name: 'stop', parameters: ['Promise'] },
      { name: 'testCrash', parameters: [] },
    ]);
  });

  // `final` and annotations are on the implementation but not the spec. If
  // either survived into the comparison, every method would read as missing.
  it('normalises final and annotations away', () => {
    expect(parseSignatures(IMPLEMENTED, NAMES))
      .toEqual(parseSignatures(GENERATED, NAMES));
  });

  it('ignores methods it was not asked about', () => {
    expect(parseSignatures('public void somethingElse(Promise p) {}', NAMES))
      .toEqual([]);
  });

  // Real generated and hand-written Java do not agree on spacing, and a
  // pattern that assumes exactly one space between tokens quietly matches
  // nothing -- which reads as "no signatures generated", not as a parse bug.
  it('tolerates irregular spacing', () => {
    expect(parseSignatures('public  void  stop( final Promise  promise ) ;', NAMES))
      .toEqual([{ name: 'stop', parameters: ['Promise'] }]);
  });

  it('keeps a generic type whose own commas split it across tokens', () => {
    expect(parseSignatures('public void stop(Map<String, Object> m);', NAMES))
      .toEqual([{ name: 'stop', parameters: ['Map<String, Object>'] }]);
  });

  // The paren-depth tracking exists for exactly this: a comma INSIDE an
  // annotation's arguments is not a parameter separator. Without it the list
  // splits in the wrong place and both halves lose their types.
  it('does not split on a comma inside an annotation', () => {
    expect(parseSignatures(
      'public void stop(@Size(min = 1, max = 2) Promise p);', NAMES,
    )).toEqual([{ name: 'stop', parameters: ['Promise'] }]);
  });

  it('keeps two parameters apart when one is annotated with arguments', () => {
    expect(parseSignatures(
      'public void launch(@Size(min = 1, max = 2) String token, ReadableMap options, Promise p);',
      NAMES,
    )).toEqual([
      { name: 'launch', parameters: ['String', 'ReadableMap', 'Promise'] },
    ]);
  });

  it('handles a generic nested inside an annotated parameter', () => {
    expect(parseSignatures(
      'public void stop(@Nullable Map<String, List<Integer>> m);', NAMES,
    )).toEqual([{ name: 'stop', parameters: ['Map<String, List<Integer>>'] }]);
  });

  it('strips an annotation that carries arguments', () => {
    expect(parseSignatures('public void stop(@Nullable(x = 1) Promise p);', NAMES))
      .toEqual([{ name: 'stop', parameters: ['Promise'] }]);
  });

  it('reads a no-argument method as having no parameters', () => {
    expect(parseSignatures('public void testCrash();', NAMES))
      .toEqual([{ name: 'testCrash', parameters: [] }]);
  });
});

describe('unimplemented', () => {
  it('is empty when the module implements everything generated', () => {
    expect(unimplemented(
      parseSignatures(GENERATED, NAMES),
      parseSignatures(IMPLEMENTED, NAMES),
    )).toEqual([]);
  });

  // The exact regression review found: stop renamed, script still passed.
  it('catches a renamed method', () => {
    const renamed = IMPLEMENTED.replace('void stop(', 'void halt(');
    expect(unimplemented(
      parseSignatures(GENERATED, NAMES),
      parseSignatures(renamed, NAMES),
    )).toEqual(['stop(Promise)']);
  });

  it('catches a changed parameter type', () => {
    const changed = IMPLEMENTED.replace('final ReadableMap options', 'final String options');
    expect(unimplemented(
      parseSignatures(GENERATED, NAMES),
      parseSignatures(changed, NAMES),
    )).toEqual(['launch(String, ReadableMap, Promise)']);
  });

  it('ignores a declaration whose parentheses never close', () => {
    expect(parseSignatures('public void stop(Promise p', NAMES)).toEqual([]);
  });

  it('formats a signature the way a reader can act on', () => {
    expect(format({ name: 'stop', parameters: ['Promise'] })).toBe('stop(Promise)');
  });
});
