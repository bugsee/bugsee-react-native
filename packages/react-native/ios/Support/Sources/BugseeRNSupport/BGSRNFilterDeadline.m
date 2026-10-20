#import "BGSRNFilterDeadline.h"

const int64_t BGSRNFilterDeadlineMs = 9000;

void BGSRNArmFilterDeadline(int64_t deadlineMs, dispatch_queue_t queue, dispatch_block_t expire) {
  if (queue == nil || expire == nil) {
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, deadlineMs * (int64_t)NSEC_PER_MSEC), queue, expire);
}

id BGSRNTakePendingFilter(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  if (table == nil || lock == nil || requestId == nil) {
    return nil;
  }
  @synchronized (lock) {
    id item = table[requestId];
    if (item != nil) {
      [table removeObjectForKey:requestId];
    }
    return item;
  }
}
