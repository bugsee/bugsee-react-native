#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The cross-SDK contract is that a blackout lasts until `endBlackout()` or
/// `stop()`. Android's SDK ends it on stop; iOS's does not, so a blackout begun
/// before `stop()` was still on after the next `launch()` (#143). The bridge
/// calls this ahead of the native stop: when `isBlackout` reports one in force
/// it runs `end` and returns YES, otherwise it does nothing and returns NO (so
/// no spurious `BlackoutEnded` when there was no blackout).
FOUNDATION_EXPORT BOOL BGSRNEndBlackoutForStop(BOOL (^isBlackout)(void), dispatch_block_t end);

NS_ASSUME_NONNULL_END
