@import XCTest;
@import BugseeRNSupport;

#import <stdatomic.h>

/// Pins `BGSRNSettleOnce`: a promise-returning native method must settle
/// exactly once even when the SDK never calls its completion (iOS simulator
/// verified fact for `logUnhandledException`).
@interface BGSRNSettleOnceTests : XCTestCase
@end

@implementation BGSRNSettleOnceTests

- (void)tearDown {
  BGSRNSettleOnceRaceWindow = nil;
  [super tearDown];
}

- (void)testSettlesOnceWhenCalled {
  XCTestExpectation *settled = [self expectationWithDescription:@"settle ran"];
  __block NSInteger count = 0;

  dispatch_queue_t queue = dispatch_queue_create("com.bugsee.rn.settle-once.test", DISPATCH_QUEUE_SERIAL);
  dispatch_block_t trigger = BGSRNSettleOnce(5000, queue, ^{
    count += 1;
    [settled fulfill];
  });

  trigger();
  trigger();

  [self waitForExpectations:@[ settled ] timeout:2];
  XCTAssertEqual(count, 1);
  XCTAssertEqual(BGSRNUnhandledCompletionDeadlineMs, 1500);
}

- (void)testSettlesAtTheDeadlineWhenNeverCalled {
  XCTestExpectation *settled = [self expectationWithDescription:@"deadline settle"];
  __block NSInteger count = 0;

  dispatch_queue_t queue = dispatch_queue_create("com.bugsee.rn.settle-once.deadline", DISPATCH_QUEUE_SERIAL);
  (void)BGSRNSettleOnce(50, queue, ^{
    count += 1;
    [settled fulfill];
  });

  [self waitForExpectations:@[ settled ] timeout:2];
  XCTAssertEqual(count, 1);
}

- (void)testACallAfterTheDeadlineDoesNothing {
  XCTestExpectation *settled = [self expectationWithDescription:@"deadline only"];
  __block NSInteger count = 0;

  dispatch_queue_t queue = dispatch_queue_create("com.bugsee.rn.settle-once.after", DISPATCH_QUEUE_SERIAL);
  dispatch_block_t trigger = BGSRNSettleOnce(50, queue, ^{
    count += 1;
    [settled fulfill];
  });

  [self waitForExpectations:@[ settled ] timeout:2];
  XCTAssertEqual(count, 1);

  trigger();
  // Give any late call a turn on the queue; count must stay 1.
  XCTestExpectation *quiet = [self expectationWithDescription:@"quiet after"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(100 * NSEC_PER_MSEC)), queue, ^{
    [quiet fulfill];
  });
  [self waitForExpectations:@[ quiet ] timeout:2];
  XCTAssertEqual(count, 1);
}

/// Two threads share a two-phase barrier around the once-flag load. An atomic
/// exchange still settles once; a plain `BOOL` lets both through. The barrier
/// makes that race deterministic rather than relying on luck.
///
/// `settle` runs on the caller threads, not the serial deadline queue, so the
/// counter is atomic: a non-atomic `count += 1` can lose a double-settle and
/// leave mutate (3) green while settling twice.
- (void)testTwoConcurrentCallsSettleOnce {
  __block atomic_int count = 0;
  dispatch_queue_t queue = dispatch_queue_create("com.bugsee.rn.settle-once.race", DISPATCH_QUEUE_SERIAL);
  // No deadline. A positive deadline is a third caller into this two-party
  // barrier, and on a slow CI runner it fires while the two threads are still
  // parked and steals a `go` signal. The threads then never leave the group.
  dispatch_block_t trigger = BGSRNSettleOnce(0, queue, ^{
    atomic_fetch_add_explicit(&count, 1, memory_order_relaxed);
  });

  dispatch_semaphore_t atWindow = dispatch_semaphore_create(0);
  dispatch_semaphore_t go = dispatch_semaphore_create(0);
  BGSRNSettleOnceRaceWindow = ^{
    dispatch_semaphore_signal(atWindow);
    dispatch_semaphore_wait(go, DISPATCH_TIME_FOREVER);
  };

  dispatch_group_t group = dispatch_group_create();
  for (int i = 0; i < 2; i++) {
    dispatch_group_async(group, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      trigger();
    });
  }

  // Phase 1: both arrive before the load. Phase 2: both have loaded.
  // A finite wait: DISPATCH_TIME_FOREVER here never returns if a caller fails
  // to arrive, and xcodebuild then sits until the job is killed.
  const dispatch_time_t arrived = dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC);
  for (int phase = 0; phase < 2; phase++) {
    XCTAssertEqual(dispatch_semaphore_wait(atWindow, arrived), 0,
                   @"caller %d did not reach the race window", phase * 2);
    XCTAssertEqual(dispatch_semaphore_wait(atWindow, arrived), 0,
                   @"caller %d did not reach the race window", phase * 2 + 1);
    dispatch_semaphore_signal(go);
    dispatch_semaphore_signal(go);
  }

  XCTAssertEqual(dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)), 0,
                 @"concurrent callers did not finish");
  XCTAssertEqual(atomic_load_explicit(&count, memory_order_relaxed), 1,
                 @"two concurrent calls settled more than once");
}

@end
