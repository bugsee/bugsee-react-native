@import XCTest;
@import BugseeRNSupport;

@interface BGSRNMainThreadTests : XCTestCase
@end

@implementation BGSRNMainThreadTests

/// The property that matters: whatever thread the caller is on, the block runs
/// on the main one. Without the hop, an off-main caller's block runs off-main
/// and the SDK touches UIKit from a background queue.
- (void)testRunsOnMainWhenCalledFromABackgroundQueue {
  XCTestExpectation *ran = [self expectationWithDescription:@"block ran"];
  __block BOOL onMain = NO;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    XCTAssertFalse([NSThread isMainThread], @"the probe must start off-main");
    BGSRNRunOnMain(^{
      onMain = [NSThread isMainThread];
      [ran fulfill];
    });
  });

  [self waitForExpectations:@[ ran ] timeout:5];
  XCTAssertTrue(onMain, @"block did not reach the main thread");
}

/// dispatch_sync onto the main queue from the main thread is a hard deadlock.
/// If this test ever hangs rather than fails, the implementation went back to
/// dispatch_sync.
- (void)testDoesNotDeadlockWhenAlreadyOnMain {
  XCTAssertTrue([NSThread isMainThread], @"XCTest runs -test methods on main");

  __block BOOL ran = NO;
  BGSRNRunOnMain(^{
    ran = YES;
  });

  // Synchronously true: the already-on-main path must run the block inline
  // rather than deferring it, or a caller that reads state straight after the
  // call sees it unset.
  XCTAssertTrue(ran, @"block was deferred instead of run inline");
}

- (void)testRunsTheBlockExactlyOnce {
  __block NSInteger count = 0;
  BGSRNRunOnMain(^{
    count += 1;
  });
  XCTAssertEqual(count, 1);
}

- (void)testToleratesANilBlock {
  XCTAssertNoThrow(BGSRNRunOnMain(nil));
}

/// The init registration must not return until `+[Bugsee setWrapper:]` has
/// run. Off main that means the hop waits; an async queue leaves a race with
/// a later main-thread `startBlackout`.
- (void)testSyncWaitsForBlockWhenCalledOffMain {
  XCTestExpectation *done = [self expectationWithDescription:@"off-main call returned"];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    XCTAssertFalse([NSThread isMainThread], @"the probe must start off-main");

    __block BOOL finished = NO;
    BGSRNRunOnMainSync(^{
      // A real main-queue turn so an async hop cannot finish the block before
      // the caller checks `finished` by accident of scheduling luck.
      XCTAssertTrue([NSThread isMainThread]);
      finished = YES;
    });
    XCTAssertTrue(finished,
                  @"BGSRNRunOnMainSync returned before the block finished; "
                  @"off-main registration would still be pending");
    [done fulfill];
  });

  [self waitForExpectations:@[ done ] timeout:5];
}

/// Same deadlock rule as BGSRNRunOnMain: sync onto main from main hangs.
- (void)testSyncDoesNotDeadlockWhenAlreadyOnMain {
  XCTAssertTrue([NSThread isMainThread], @"XCTest runs -test methods on main");

  __block BOOL ran = NO;
  BGSRNRunOnMainSync(^{
    ran = YES;
  });
  XCTAssertTrue(ran, @"block was deferred instead of run inline");
}

- (void)testSyncToleratesANilBlock {
  XCTAssertNoThrow(BGSRNRunOnMainSync(nil));
}

@end
