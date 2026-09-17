#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs @c block on the main thread, without deadlocking if already there.
///
/// The Bugsee SDK touches UIKit during start-up, and React Native delivers
/// TurboModule calls on a background queue — measured on device, every call
/// arrives with @c isMainThread==0. So the hop is load-bearing, not defensive.
///
/// @c dispatch_sync onto the main queue from the main thread is a hard
/// deadlock, and React Native does sometimes invoke a TurboModule method on
/// the main thread, so the already-on-main case must run the block directly.
///
/// This lives in the Support package rather than beside its caller so that it
/// can be tested: removing the hop is otherwise invisible — the device e2e
/// still passes without it.
FOUNDATION_EXPORT void BGSRNRunOnMain(dispatch_block_t block);

NS_ASSUME_NONNULL_END
