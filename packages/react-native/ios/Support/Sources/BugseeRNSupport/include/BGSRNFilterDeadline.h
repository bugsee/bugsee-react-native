#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// How long JS gets to answer one filter request (log, network, breadcrumb)
/// before the wrapper drops the item.
///
/// The iOS SDK has no timeout for any of these filters: a late decision is
/// still recorded, and one that never comes leaves the request, and the event
/// it retains, in the bridge's pending table until the process dies. The
/// wrapper therefore sets its own, failing closed: past the deadline the
/// decision block is called with nil (drop), the entry is removed, and a late
/// reply finds nothing and is a no-op. It is never answered with the original
/// item: that would pass through exactly what the filter exists to redact.
///
/// 9 s is the Android number: its log and network bridges forget a request at
/// 9 s, inside the SDK's own 10 s recycle.
FOUNDATION_EXPORT const int64_t BGSRNFilterDeadlineMs;

/// Runs `expire` on `queue` after `deadlineMs`. Not cancellable: `expire` is
/// expected to find the request already answered and do nothing, which
/// `BGSRNTakePendingFilter` makes the normal case.
FOUNDATION_EXPORT void BGSRNArmFilterDeadline(int64_t deadlineMs,
                                              dispatch_queue_t _Nullable queue,
                                              dispatch_block_t _Nullable expire);

/// Removes and returns the pending item for `requestId`, or nil when it was
/// already answered, expired, or torn down. The removal is under `lock`, so a
/// reply and the deadline cannot both take the same item: whoever gets it
/// calls the SDK's decision block, and the other does nothing.
FOUNDATION_EXPORT _Nullable id BGSRNTakePendingFilter(NSMutableDictionary<NSString *, id> *table,
                                                      id lock,
                                                      NSString *_Nullable requestId);

NS_ASSUME_NONNULL_END
