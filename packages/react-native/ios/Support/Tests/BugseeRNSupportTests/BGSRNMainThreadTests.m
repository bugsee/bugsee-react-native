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

@end
