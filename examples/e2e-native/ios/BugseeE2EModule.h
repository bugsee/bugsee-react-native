#import <Foundation/Foundation.h>
#import <BugseeE2ENativeSpec/BugseeE2ENativeSpec.h>

NS_ASSUME_NONNULL_BEGIN

/// The iOS half of the example-only `BugseeE2E` TurboModule (Task 7.6a).
/// Never shipped: only examples/bare depends on the package.
@interface BugseeE2EModule : NSObject <NativeBugseeE2ESpec>
@end

NS_ASSUME_NONNULL_END
