#import "BGSRNSettleOnce.h"

#import <stdatomic.h>

const int64_t BGSRNUnhandledCompletionDeadlineMs = 1500;

dispatch_block_t BGSRNSettleOnceRaceWindow = nil;

/// Shared by the returned trigger and the deadline block. Lives as long as
/// either capture does, so a late call after the other path already settled
/// never touches freed memory.
@interface BGSRNSettleOnceState : NSObject {
 @public
  atomic_bool once;
}
@property (nonatomic, copy) dispatch_block_t settle;
@end

@implementation BGSRNSettleOnceState
@end

static void RunRaceWindow(void) {
  dispatch_block_t window = BGSRNSettleOnceRaceWindow;
  if (window != nil) {
    window();
  }
}

dispatch_block_t BGSRNSettleOnce(int64_t deadlineMs, dispatch_queue_t queue, dispatch_block_t settle) {
  if (settle == nil || queue == nil) {
    return ^{
    };
  }

  BGSRNSettleOnceState *state = [BGSRNSettleOnceState new];
  atomic_init(&state->once, false);
  state.settle = settle;

  void (^fire)(void) = ^{
    // Two windows so a test can park both callers before the load and again
    // after it: a non-atomic once-flag then loses deterministically (both saw
    // unset), while atomic_exchange still admits only one settler.
    RunRaceWindow();
    const bool already = atomic_load(&state->once);
    RunRaceWindow();
    if (already) {
      return;
    }
    if (atomic_exchange(&state->once, true)) {
      return;
    }
    state.settle();
  };

  if (deadlineMs > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, deadlineMs * (int64_t)NSEC_PER_MSEC), queue, ^{
      fire();
    });
  }

  return [fire copy];
}
