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

/// Runs `expire` on `queue` after `deadlineMs`. Returns a token for
/// `BGSRNCancelFilterDeadline`; the timer itself is a `dispatch_after`, which
/// GCD cannot unschedule, so cancelling stops the block from running but the
/// (tiny) block stays queued until the 9 s are up.
FOUNDATION_EXPORT _Nullable dispatch_block_t BGSRNArmFilterDeadline(
    int64_t deadlineMs,
    dispatch_queue_t _Nullable queue,
    dispatch_block_t _Nullable expire);

FOUNDATION_EXPORT void BGSRNCancelFilterDeadline(_Nullable dispatch_block_t token);

/// Removes and returns the pending item for `requestId`, or nil when it was
/// already answered, expired, or torn down. The removal is under `lock`, so a
/// reply and the deadline cannot both take the same item: whoever gets it
/// calls the SDK's decision block, and the other does nothing. If the item has
/// a `deadline` property, its timer is cancelled here, so every reply path
/// that takes the item also stops its timer. If it has an `expiresAt`
/// property (a monotonic `CLOCK_UPTIME_RAW` instant in nanoseconds, set when
/// the deadline is armed) and that instant has passed, the item is overdue
/// even though the timer block may not have run (a starved queue): it is
/// answered with nil here and nil is returned, so a late reply is never
/// applied.
FOUNDATION_EXPORT _Nullable id BGSRNTakePendingFilter(NSMutableDictionary<NSString *, id> *table,
                                                      id lock,
                                                      NSString *_Nullable requestId);

/// Starts the deadline for a request already in `table`. When it passes and
/// the request is still pending, the item is taken and its `decision` block is
/// called with nil (drop). Never with the original. Stores the timer token in
/// the item's `deadline` property when it has one.
FOUNDATION_EXPORT void BGSRNArmPendingFilterDeadline(NSMutableDictionary<NSString *, id> *table,
                                                     id lock,
                                                     NSString *requestId);

/// As above with an explicit deadline and queue, for tests.
FOUNDATION_EXPORT void BGSRNArmPendingFilterDeadlineAfter(int64_t deadlineMs,
                                                          dispatch_queue_t queue,
                                                          NSMutableDictionary<NSString *, id> *table,
                                                          id lock,
                                                          NSString *requestId);

/// Takes `requestId` and answers its `decision` block with nil. Returns
/// whether it was still pending. The deadline's whole effect, separate so it
/// can be tested without waiting.
FOUNDATION_EXPORT BOOL BGSRNDropPendingFilter(NSMutableDictionary<NSString *, id> *table,
                                              id lock,
                                              NSString *requestId);

NS_ASSUME_NONNULL_END
