#import "BGSRNFilterDeadline.h"

const int64_t BGSRNFilterDeadlineMs = 9000;

dispatch_block_t BGSRNArmFilterDeadline(int64_t deadlineMs, dispatch_queue_t queue, dispatch_block_t expire) {
  if (queue == nil || expire == nil) {
    return nil;
  }
  dispatch_block_t token = dispatch_block_create(0, expire);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, deadlineMs * (int64_t)NSEC_PER_MSEC), queue, token);
  return token;
}

void BGSRNCancelFilterDeadline(dispatch_block_t token) {
  if (token != nil) {
    dispatch_block_cancel(token);
  }
}

id BGSRNTakePendingFilter(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  if (table == nil || lock == nil || requestId == nil) {
    return nil;
  }
  id item = nil;
  @synchronized (lock) {
    item = table[requestId];
    if (item != nil) {
      [table removeObjectForKey:requestId];
    }
  }
  if (item != nil && [item respondsToSelector:NSSelectorFromString(@"deadline")]) {
    BGSRNCancelFilterDeadline([item valueForKey:@"deadline"]);
  }
  return item;
}

BOOL BGSRNDropPendingFilter(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  id item = BGSRNTakePendingFilter(table, lock, requestId);
  if (item == nil) {
    return NO;
  }
  void (^decision)(id) = [item valueForKey:@"decision"];
  if (decision != nil) {
    decision(nil);
  }
  return YES;
}

void BGSRNArmPendingFilterDeadlineAfter(int64_t deadlineMs,
                                        dispatch_queue_t queue,
                                        NSMutableDictionary<NSString *, id> *table,
                                        id lock,
                                        NSString *requestId) {
  dispatch_block_t token = BGSRNArmFilterDeadline(deadlineMs, queue, ^{
    BGSRNDropPendingFilter(table, lock, requestId);
  });
  if (token == nil) {
    return;
  }
  id item = nil;
  @synchronized (lock) {
    item = table[requestId];
  }
  if (item != nil && [item respondsToSelector:NSSelectorFromString(@"setDeadline:")]) {
    [item setValue:token forKey:@"deadline"];
  } else {
    // Nothing to hold it, or already answered: the timer finds nothing.
  }
}

void BGSRNArmPendingFilterDeadline(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  BGSRNArmPendingFilterDeadlineAfter(BGSRNFilterDeadlineMs,
                                     dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
                                     table, lock, requestId);
}
