@import XCTest;
@import BugseeRNSupport;

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
- (void)testTwoConcurrentCallsSettleOnce {
  __block NSInteger count = 0;
  dispatch_queue_t queue = dispatch_queue_create("com.bugsee.rn.settle-once.race", DISPATCH_QUEUE_SERIAL);
  dispatch_block_t trigger = BGSRNSettleOnce(5000, queue, ^{
    count += 1;
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
  for (int phase = 0; phase < 2; phase++) {
    dispatch_semaphore_wait(atWindow, DISPATCH_TIME_FOREVER);
    dispatch_semaphore_wait(atWindow, DISPATCH_TIME_FOREVER);
    dispatch_semaphore_signal(go);
    dispatch_semaphore_signal(go);
  }

  XCTAssertEqual(dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)), 0,
                 @"concurrent callers did not finish");
  XCTAssertEqual(count, 1, @"two concurrent calls settled more than once");
}

@end
