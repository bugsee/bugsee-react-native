#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// A boxed `BOOL` whose identity IS the `CFBoolean` singleton, rather than
/// whatever `@(value)` happens to box a `BOOL` into.
///
/// `+[Bugsee trace:value:]` takes `id`, and the SDK's JSON writer
/// special-cases `CFBoolean` to serialise as `true`/`false` (design doc
/// Phase 4, verified facts); anything else numeric serialises as a number in
/// its shortest round-trip form. A `BOOL` boxed the ordinary way is not
/// reliably a `CFBoolean` -- `@(value)` for a `BOOL` can produce an
/// `NSNumber` backed by a `char`, indistinguishable at that point from a
/// `Boolean`-typed value holding 0 or 1 -- so the boolean identity cannot be
/// left to depend on how a given architecture boxes it. This forces it.
FOUNDATION_EXPORT NSNumber *BGSRNBoolNumber(BOOL value);

NS_ASSUME_NONNULL_END
