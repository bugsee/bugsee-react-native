#import <Foundation/Foundation.h>
#import <React/RCTInvalidating.h>
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
/// Inherits NativeBugseeSpecBase rather than NSObject because the spec
/// declares an EventEmitter: codegen puts `emitOnLifecycleEvent:` on that base
/// class, not on the protocol, so an NSObject subclass conforms to
/// NativeBugseeSpec and still cannot emit. The compiler says
/// "no visible @interface ... declares the selector", which points at the call
/// site rather than at the superclass that is actually wrong.
@interface BugseeModule : NativeBugseeSpecBase <NativeBugseeSpec, RCTInvalidating>
@end

NS_ASSUME_NONNULL_END
