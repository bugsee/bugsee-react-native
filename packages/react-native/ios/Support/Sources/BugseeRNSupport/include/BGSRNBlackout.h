#import <Foundation/Foundation.h>
#import <Bugsee/Bugsee.h>

NS_ASSUME_NONNULL_BEGIN

/// TODO(#143): temporary wrapper workaround. The contract is that a blackout
/// lasts until `endBlackout()` or `stop()`; Android's SDK ends it on stop, the
/// iOS SDK does not, so it survived into the next `launch()`. This belongs in
/// the iOS SDK (every wrapper is affected); delete this once it ends the
/// blackout itself.
///
/// Ends a blackout in force and returns YES, when `status` is not Stopped. A
/// Stopped SDK is left alone: a `startBlackout()` made before `launch()` is
/// deliberately held until launch, and `stop()` on a never-launched SDK must
/// not cancel it. NO, and no `endBlackout`, when there is nothing to end (so
/// no spurious `BlackoutEnded`).
FOUNDATION_EXPORT BOOL BGSRNEndBlackoutForStopWithStatus(BugseeStatus status);

/// The same, reading the SDK's current status. Call on the main queue, ahead
/// of the native stop.
FOUNDATION_EXPORT BOOL BGSRNEndBlackoutForStop(void);

NS_ASSUME_NONNULL_END
