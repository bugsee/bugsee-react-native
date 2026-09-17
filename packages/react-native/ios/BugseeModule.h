#import <Foundation/Foundation.h>
#import <RNBugseeSpec/RNBugseeSpec.h>

NS_ASSUME_NONNULL_BEGIN

/// The iOS half of the `Bugsee` TurboModule.
///
/// Every SDK entry point is reached on the main thread. `launchWithToken:`
/// called from the TurboModule's own queue logs "Incorrect bugsee launch,
/// please make sure that you run bugsee in main thread!" and does not start
/// correctly — reproduced on device, not inferred.
///
/// Translation between the JS wire shape and the SDK's types lives in
/// BugseeRNSupport, which is unit-tested without React Native.
@interface BugseeModule : NSObject <NativeBugseeSpec>
@end

NS_ASSUME_NONNULL_END
