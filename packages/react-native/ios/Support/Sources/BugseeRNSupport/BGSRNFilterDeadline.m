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

static uint64_t BGSRNNowNanos(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
}

/// Removes the item. `overdue` says its deadline has passed, whether or not
/// the timer block has run: a starved queue can run it late, and a reply that
/// gets here first must not be applied past 9 s.
static id BGSRNTakeRaw(NSMutableDictionary<NSString *, id> *table,
                       id lock,
                       NSString *requestId,
                       BOOL *overdue) {
  *overdue = NO;
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
  if (item != nil && [item respondsToSelector:NSSelectorFromString(@"expiresAt")]) {
    NSNumber *expiresAt = [item valueForKey:@"expiresAt"];
    *overdue = expiresAt != nil && BGSRNNowNanos() >= expiresAt.unsignedLongLongValue;
  }
  return item;
}

static void BGSRNAnswerNil(id item) {
  void (^decision)(id) = [item valueForKey:@"decision"];
  if (decision != nil) {
    decision(nil);
  }
}

id BGSRNTakePendingFilter(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  BOOL overdue = NO;
  id item = BGSRNTakeRaw(table, lock, requestId, &overdue);
  if (item != nil && overdue) {
    // Past the deadline the answer is refused: drop, never apply the reply.
    BGSRNAnswerNil(item);
    return nil;
  }
  return item;
}

BOOL BGSRNDropPendingFilter(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  BOOL overdue = NO;
  id item = BGSRNTakeRaw(table, lock, requestId, &overdue);
  if (item == nil) {
    return NO;
  }
  BGSRNAnswerNil(item);
  return YES;
}

void BGSRNArmPendingFilterDeadlineAfter(int64_t deadlineMs,
                                        dispatch_queue_t queue,
                                        NSMutableDictionary<NSString *, id> *table,
                                        id lock,
                                        NSString *requestId) {
  const uint64_t expiresAt = BGSRNNowNanos() + (uint64_t)deadlineMs * NSEC_PER_MSEC;
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
    if ([item respondsToSelector:NSSelectorFromString(@"setExpiresAt:")]) {
      [item setValue:@(expiresAt) forKey:@"expiresAt"];
    }
  } else {
    // Nothing to hold it, or already answered: the timer finds nothing.
  }
}

void BGSRNArmPendingFilterDeadline(NSMutableDictionary<NSString *, id> *table, id lock, NSString *requestId) {
  BGSRNArmPendingFilterDeadlineAfter(BGSRNFilterDeadlineMs,
                                     dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
                                     table, lock, requestId);
}
