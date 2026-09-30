#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Matches JS `UNHANDLED_REPORT_WAIT_MS`: the most the fatal path waits for
/// native before RN's handler runs. On the simulator the SDK never calls the
/// `logUnhandledException` completion (verified facts), so the promise must
/// still settle by this deadline.
FOUNDATION_EXPORT const int64_t BGSRNUnhandledCompletionDeadlineMs;

/// Runs `settle` exactly once: when the returned block is first called, or
/// after `deadlineMs` on `queue`, whichever comes first. The once-flag is
/// atomic: the SDK may call back on any thread.
FOUNDATION_EXPORT dispatch_block_t BGSRNSettleOnce(int64_t deadlineMs,
                                                   dispatch_queue_t queue,
                                                   dispatch_block_t settle);

/// Test-only: runs on every claim attempt, just before the once-flag is
/// examined. Nil in production. The concurrent settle test parks two threads
/// here so a non-atomic once-flag loses deterministically rather than by luck.
FOUNDATION_EXPORT _Nullable dispatch_block_t BGSRNSettleOnceRaceWindow;

NS_ASSUME_NONNULL_END
