#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The longest `BGSRNDeleteCollectedData` waits for the SDK completion. Long on
/// purpose: a deletion that is merely slow (it can queue behind an upload that
/// holds the SDK's processing queue) must still report its real outcome, so
/// this is a backstop against a promise that never settles, not a deadline.
FOUNDATION_EXPORT const int64_t BGSRNDeleteCollectedDataBackstopMs;

/// Reject code when the backstop fires first. The deletion may still finish
/// later; the caller learns that the outcome is unknown, not that it failed.
FOUNDATION_EXPORT NSString *const BGSRNDeleteTimeoutCode;

/// The SDK call, handed the completion to invoke with the SDK's outcome.
typedef void (^BGSRNDeleteSDKCall)(void (^completion)(BOOL success));

/// Runs `sdkCall` and settles exactly once, on `queue` (which must be serial):
/// `resolve` with the SDK's success, or `reject` with
/// `BGSRNDeleteTimeoutCode` if `backstopMs` passes first. A completion that
/// arrives after the backstop, or a second completion, is ignored. The
/// completion may be called on any thread.
FOUNDATION_EXPORT void BGSRNDeleteCollectedData(BGSRNDeleteSDKCall sdkCall,
                                                int64_t backstopMs,
                                                dispatch_queue_t queue,
                                                void (^resolve)(BOOL success),
                                                void (^reject)(NSString *code, NSString *message));

NS_ASSUME_NONNULL_END
